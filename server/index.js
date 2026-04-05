import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8020);
const VIDEOS_DIR = process.env.VIDEOS_DIR || '/streaming/Videos';
const HLS_VOD_DIR = process.env.HLS_VOD_DIR || '/var/hls/vod';
const VOD_FFMPEG_CONCURRENCY = Math.max(
  1,
  Number.parseInt(String(process.env.VOD_FFMPEG_CONCURRENCY || '2'), 10) || 2,
);
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'app.db');
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_INITIAL_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || '';

const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov']);

function hashFileKey(relativePath) {
  return crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 32);
}

function walkMediaFiles(dir, baseDir, onFile) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkMediaFiles(full, baseDir, onFile);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (MEDIA_EXT.has(ext)) {
        const relFromVideos = path.relative(VIDEOS_DIR, full).replace(/\\/g, '/');
        onFile(full, relFromVideos);
      }
    }
  }
}

let libraryCache = { at: 0, data: null, fileMap: new Map() };
const LIBRARY_TTL_MS = 30_000;

function buildLibrary() {
  const roots = [];
  const fileMap = new Map();
  if (!fs.existsSync(VIDEOS_DIR)) {
    return { roots, fileMap };
  }
  const rootDirs = fs
    .readdirSync(VIDEOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  for (const rootName of rootDirs) {
    const rootPath = path.join(VIDEOS_DIR, rootName);
    const playlists = [];
    let plEntries = [];
    try {
      plEntries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pl of plEntries) {
      if (!pl.isDirectory() || pl.name.startsWith('.')) continue;
      const playlistPath = path.join(rootPath, pl.name);
      const items = [];
      walkMediaFiles(playlistPath, playlistPath, (absPath, relFromVideos) => {
        const fileId = hashFileKey(relFromVideos);
        const title = path.basename(absPath);
        const hlsUrl = `/hls/vod/${fileId}/index.m3u8`;
        items.push({
          id: fileId,
          title,
          relativePath: relFromVideos,
          rootId: rootName,
          playlistId: pl.name,
          hlsUrl,
        });
        fileMap.set(fileId, {
          absPath,
          relFromVideos,
          rootId: rootName,
          playlistId: pl.name,
          title,
        });
      });
      items.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
      );
      playlists.push({
        id: pl.name,
        name: pl.name,
        items,
      });
    }

    const rootItems = [];
    for (const ent of plEntries) {
      if (!ent.isFile() || ent.name.startsWith('.')) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!MEDIA_EXT.has(ext)) continue;
      const absPath = path.join(rootPath, ent.name);
      let relFromVideos;
      try {
        relFromVideos = path.relative(VIDEOS_DIR, absPath).replace(/\\/g, '/');
      } catch {
        continue;
      }
      const fileId = hashFileKey(relFromVideos);
      const title = ent.name;
      const hlsUrl = `/hls/vod/${fileId}/index.m3u8`;
      rootItems.push({
        id: fileId,
        title,
        relativePath: relFromVideos,
        rootId: rootName,
        playlistId: '__root__',
        hlsUrl,
      });
      fileMap.set(fileId, {
        absPath,
        relFromVideos,
        rootId: rootName,
        playlistId: '__root__',
        title,
      });
    }
    rootItems.sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    );
    if (rootItems.length > 0) {
      playlists.push({
        id: '__root__',
        name: 'In this course',
        items: rootItems,
      });
    }

    playlists.sort((a, b) => {
      if (a.id === '__root__') return -1;
      if (b.id === '__root__') return 1;
      return a.name.localeCompare(b.name);
    });
    const itemCount = playlists.reduce((n, p) => n + p.items.length, 0);
    roots.push({
      id: rootName,
      name: rootName,
      playlists,
      itemCount,
    });
  }
  return { roots, fileMap };
}

function getLibrary() {
  const now = Date.now();
  if (!libraryCache.data || now - libraryCache.at > LIBRARY_TTL_MS) {
    const { roots, fileMap } = buildLibrary();
    libraryCache = { at: now, data: { roots }, fileMap };
  }
  return libraryCache;
}

function getFileMeta(fileId) {
  const { fileMap } = getLibrary();
  return fileMap.get(fileId) || null;
}

const vodLocks = new Map();

let vodTranscodeActive = 0;
const vodTranscodeWaitQueue = [];

function acquireVodTranscodeSlot() {
  if (vodTranscodeActive < VOD_FFMPEG_CONCURRENCY) {
    vodTranscodeActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    vodTranscodeWaitQueue.push(resolve);
  });
}

function releaseVodTranscodeSlot() {
  vodTranscodeActive--;
  const next = vodTranscodeWaitQueue.shift();
  if (next) {
    vodTranscodeActive++;
    next();
  }
}

const VOD_PLAYABLE_WAIT_MS = Number.parseInt(String(process.env.VOD_PLAYABLE_WAIT_MS || ''), 10) || 1_800_000;
const VOD_ENCODING_LOCK_STALE_MS =
  Number.parseInt(String(process.env.VOD_ENCODING_LOCK_STALE_MS || ''), 10) || 4 * 60 * 60 * 1000;

const vodEncodingLockDir = path.join(HLS_VOD_DIR, '.locks');

function vodEncodingLockPath(fileId) {
  return path.join(vodEncodingLockDir, `${fileId}.lock`);
}

function vodIndexFresh(indexPath, srcMtime) {
  try {
    const st = fs.statSync(indexPath);
    return st.mtimeMs >= srcMtime;
  } catch {
    return false;
  }
}

/** True when manifest is up to date and at least one listed segment exists on disk (same bar as waitForPlayableHls). */
function isVodHlsPlayable(fileId) {
  const meta = getFileMeta(fileId);
  if (!meta) return false;
  let srcMtime = 0;
  try {
    srcMtime = fs.statSync(meta.absPath).mtimeMs;
  } catch {
    return false;
  }
  const indexPath = path.join(HLS_VOD_DIR, fileId, 'index.m3u8');
  if (!vodIndexFresh(indexPath, srcMtime)) return false;
  try {
    const txt = fs.readFileSync(indexPath, 'utf8');
    if (!txt.includes('#EXTINF')) return false;
    const lines = txt.split(/\r?\n/);
    const outDir = path.dirname(indexPath);
    for (const line of lines) {
      const t = line.trim();
      if (t && !t.startsWith('#')) {
        const segPath = path.join(outDir, t);
        try {
          if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) return true;
        } catch {
          /* keep scanning */
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Cross-process mutex: in-memory vodLocks do not span multiple Node workers/containers.
 * Without this, each process spawns ffmpeg for the same file and rmSync fights others.
 */
function tryAcquireEncodingLock(fileId, depth = 0) {
  if (depth > 8) return null;
  fs.mkdirSync(vodEncodingLockDir, { recursive: true });
  const p = vodEncodingLockPath(fileId);
  try {
    const fd = fs.openSync(p, 'wx');
    try {
      fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
    } finally {
      fs.closeSync(fd);
    }
    return () => {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    };
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return tryAcquireEncodingLock(fileId, depth + 1);
    }
    if (Date.now() - st.mtimeMs > VOD_ENCODING_LOCK_STALE_MS) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
      return tryAcquireEncodingLock(fileId, depth + 1);
    }
    return null;
  }
}

async function waitForVodFromPeer(fileId, outDir, indexPath, srcMtime) {
  const deadline = Date.now() + VOD_PLAYABLE_WAIT_MS;
  const lockP = vodEncodingLockPath(fileId);
  while (Date.now() < deadline) {
    if (vodIndexFresh(indexPath, srcMtime)) {
      return outDir;
    }
    if (!fs.existsSync(lockP)) {
      await new Promise((r) => setTimeout(r, 100));
      return ensureVodHls(fileId);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const err = new Error('Timed out waiting for VOD transcode');
  err.code = 'TIMEOUT';
  throw err;
}

function ffmpegVodArgs(meta, outDir) {
  const indexM3u8 = path.join(outDir, 'index.m3u8');
  return [
    '-y',
    '-i',
    meta.absPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(outDir, 'segment%03d.ts'),
    indexM3u8,
  ];
}

/**
 * Resolve when index.m3u8 lists at least one .ts that exists and is non-empty,
 * or when ffmpeg has already exited successfully (short / fast encode).
 */
function waitForPlayableHls(outDir, ff, timeoutMs) {
  const indexPath = path.join(outDir, 'index.m3u8');
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (ff.exitCode !== null) {
        clearInterval(iv);
        if (ff.exitCode === 0) {
          try {
            const txt = fs.readFileSync(indexPath, 'utf8');
            if (txt.includes('#EXTINF')) {
              resolve();
              return;
            }
          } catch {
            /* fall through */
          }
          reject(Object.assign(new Error('ffmpeg exited but manifest is not usable'), { code: 'FFMPEG' }));
        } else {
          reject(Object.assign(new Error(`ffmpeg exited ${ff.exitCode}`), { code: 'FFMPEG' }));
        }
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(iv);
        try {
          ff.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(Object.assign(new Error('Timed out waiting for first HLS segment'), { code: 'TIMEOUT' }));
        return;
      }
      try {
        if (!fs.existsSync(indexPath)) return;
        const txt = fs.readFileSync(indexPath, 'utf8');
        if (!txt.includes('#EXTINF')) return;
        const lines = txt.split(/\r?\n/);
        for (const line of lines) {
          const t = line.trim();
          if (t && !t.startsWith('#')) {
            const segPath = path.join(outDir, t);
            try {
              if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) {
                clearInterval(iv);
                resolve();
                return;
              }
            } catch {
              /* keep polling */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }, 150);
  });
}

function waitForFfmpegClose(ff, stderr) {
  return new Promise((resolve, reject) => {
    if (ff.exitCode !== null) {
      if (ff.exitCode === 0) resolve();
      else {
        const err = new Error((stderr || '').slice(-500) || `ffmpeg exited ${ff.exitCode}`);
        err.code = 'FFMPEG';
        reject(err);
      }
      return;
    }
    ff.once('close', (code) => {
      if (code !== 0) {
        const err = new Error((stderr || '').slice(-500) || `ffmpeg exited ${code}`);
        err.code = 'FFMPEG';
        reject(err);
      } else resolve();
    });
  });
}

function ensureVodHls(fileId) {
  const meta = getFileMeta(fileId);
  if (!meta) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    return Promise.reject(err);
  }
  const outDir = path.join(HLS_VOD_DIR, fileId);
  const indexPath = path.join(outDir, 'index.m3u8');
  let srcMtime = 0;
  try {
    srcMtime = fs.statSync(meta.absPath).mtimeMs;
  } catch {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    return Promise.reject(err);
  }
  if (vodIndexFresh(indexPath, srcMtime)) return Promise.resolve(outDir);

  const existing = vodLocks.get(fileId);
  if (existing) return existing;

  const releaseEncodingLock = tryAcquireEncodingLock(fileId);
  if (!releaseEncodingLock) {
    return waitForVodFromPeer(fileId, outDir, indexPath, srcMtime);
  }

  let resolveHttp;
  let rejectHttp;
  const httpPromise = new Promise((res, rej) => {
    resolveHttp = res;
    rejectHttp = rej;
  });
  let httpSettled = false;
  const settleHttp = (err, value) => {
    if (httpSettled) return;
    httpSettled = true;
    if (err) rejectHttp(err);
    else resolveHttp(value);
  };

  vodLocks.set(fileId, httpPromise);

  (async () => {
    let stderr = '';
    let ff = null;
    await acquireVodTranscodeSlot();
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      ff = spawn('ffmpeg', ffmpegVodArgs(meta, outDir), { stdio: ['ignore', 'ignore', 'pipe'] });
      ff.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      const spawnOrRunError = new Promise((_, rej) => {
        ff.once('error', rej);
      });
      await Promise.race([waitForPlayableHls(outDir, ff, VOD_PLAYABLE_WAIT_MS), spawnOrRunError]);
      settleHttp(null, outDir);

      await waitForFfmpegClose(ff, stderr);
    } catch (e) {
      const clientAlreadyHasManifest = httpSettled;
      settleHttp(e);
      if (ff && ff.exitCode === null) {
        try {
          ff.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      if (!clientAlreadyHasManifest) {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    } finally {
      try {
        releaseEncodingLock();
      } catch {
        /* ignore */
      }
      releaseVodTranscodeSlot();
      vodLocks.delete(fileId);
    }
  })();

  return httpPromise;
}

function initDb() {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  const db = new Database(DATABASE_PATH);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id INTEGER NOT NULL,
      file_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, file_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS watch_progress (
      user_id INTEGER NOT NULL,
      file_id TEXT NOT NULL,
      position_seconds REAL NOT NULL,
      duration_seconds REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, file_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`).get().c;
  if (adminCount === 0) {
    if (!ADMIN_INITIAL_PASSWORD || ADMIN_INITIAL_PASSWORD.length < 8) {
      throw new Error(
        'No admin user in database: set ADMIN_INITIAL_PASSWORD (min 8 characters) for first boot.',
      );
    }
    const password_hash = bcrypt.hashSync(ADMIN_INITIAL_PASSWORD, 12);
    db.prepare(
      `INSERT INTO users (username, password_hash, role, must_change_password, created_at)
       VALUES ('admin', ?, 'admin', 1, datetime('now'))`,
    ).run(password_hash);
    console.log('[db] Created bootstrap admin user (must change password on first login).');
  }

  return db;
}

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET must be set and at least 16 characters.');
  process.exit(1);
}

const db = initDb();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

function parseBearer(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

function authMiddleware(requireFull = true) {
  return (req, res, next) => {
    const token = parseBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db
        .prepare(
          `SELECT id, username, role, must_change_password FROM users WHERE id = ?`,
        )
        .get(payload.sub);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.user = user;
      if (requireFull && user.must_change_password) {
        return res.status(403).json({ error: 'must_change_password', mustChangePassword: true });
      }
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = db
    .prepare(`SELECT id, username, password_hash, role, must_change_password FROM users WHERE username = ?`)
    .get(String(username));
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
    mustChangePassword: !!user.must_change_password,
  });
});

app.post('/api/auth/change-password', authMiddleware(false), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'currentPassword and newPassword (min 8) required' });
  }
  const row = db
    .prepare(`SELECT password_hash, must_change_password FROM users WHERE id = ?`)
    .get(req.user.id);
  if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
    return res.status(400).json({ error: 'Current password incorrect' });
  }
  const password_hash = bcrypt.hashSync(String(newPassword), 12);
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`,
  ).run(password_hash, req.user.id);
  const user = db
    .prepare(`SELECT id, username, role, must_change_password FROM users WHERE id = ?`)
    .get(req.user.id);
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
    mustChangePassword: false,
  });
});

app.get('/api/auth/me', authMiddleware(false), (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
    },
    mustChangePassword: !!req.user.must_change_password,
  });
});

app.get('/api/library', authMiddleware(true), (req, res) => {
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  const { data } = getLibrary();
  res.json(data);
});

function enrichBookmarkRow(row) {
  const meta = getFileMeta(row.file_id);
  return {
    fileId: row.file_id,
    title: meta?.title || row.file_id,
    rootId: meta?.rootId || null,
    playlistId: meta?.playlistId || null,
    addedAt: row.created_at,
    hlsUrl: meta ? `/hls/vod/${row.file_id}/index.m3u8` : null,
  };
}

app.get('/api/bookmarks', authMiddleware(true), (req, res) => {
  const rows = db
    .prepare(
      `SELECT file_id, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(req.user.id);
  res.json({ bookmarks: rows.map(enrichBookmarkRow) });
});

app.post('/api/bookmarks', authMiddleware(true), (req, res) => {
  const { fileId } = req.body || {};
  if (!fileId || !getFileMeta(fileId)) {
    return res.status(400).json({ error: 'Invalid fileId' });
  }
  db.prepare(
    `INSERT OR IGNORE INTO bookmarks (user_id, file_id, created_at) VALUES (?, ?, datetime('now'))`,
  ).run(req.user.id, fileId);
  const row = db
    .prepare(`SELECT file_id, created_at FROM bookmarks WHERE user_id = ? AND file_id = ?`)
    .get(req.user.id, fileId);
  res.json(enrichBookmarkRow(row));
});

app.delete('/api/bookmarks/:fileId', authMiddleware(true), (req, res) => {
  const { fileId } = req.params;
  db.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND file_id = ?`).run(req.user.id, fileId);
  res.status(204).end();
});

app.get('/api/progress', authMiddleware(true), (req, res) => {
  const { fileId, limit } = req.query;
  if (fileId) {
    const row = db
      .prepare(
        `SELECT file_id, position_seconds, duration_seconds, updated_at FROM watch_progress WHERE user_id = ? AND file_id = ?`,
      )
      .get(req.user.id, String(fileId));
    return res.json({ progress: row || null });
  }
  const lim = Math.min(50, Math.max(1, parseInt(String(limit || '20'), 10) || 20));
  const rows = db
    .prepare(
      `SELECT file_id, position_seconds, duration_seconds, updated_at FROM watch_progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(req.user.id, lim);
  res.json({
    progress: rows.map((r) => {
      const meta = getFileMeta(r.file_id);
      return {
        fileId: r.file_id,
        positionSeconds: r.position_seconds,
        durationSeconds: r.duration_seconds,
        updatedAt: r.updated_at,
        title: meta?.title,
        rootId: meta?.rootId,
        playlistId: meta?.playlistId,
        hlsUrl: meta ? `/hls/vod/${r.file_id}/index.m3u8` : null,
      };
    }),
  });
});

const progressLastWrite = new Map();
const PROGRESS_MIN_INTERVAL_MS = 2000;

app.put('/api/progress', authMiddleware(true), (req, res) => {
  const { fileId, positionSeconds, durationSeconds } = req.body || {};
  if (!fileId || typeof positionSeconds !== 'number' || !Number.isFinite(positionSeconds)) {
    return res.status(400).json({ error: 'fileId and positionSeconds required' });
  }
  if (!getFileMeta(fileId)) {
    return res.status(400).json({ error: 'Invalid fileId' });
  }
  const key = `${req.user.id}:${fileId}`;
  const now = Date.now();
  const last = progressLastWrite.get(key) || 0;
  if (now - last < PROGRESS_MIN_INTERVAL_MS) {
    return res.json({ ok: true, throttled: true });
  }
  progressLastWrite.set(key, now);
  db.prepare(
    `INSERT INTO watch_progress (user_id, file_id, position_seconds, duration_seconds, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, file_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = COALESCE(excluded.duration_seconds, duration_seconds),
       updated_at = excluded.updated_at`,
  ).run(
    req.user.id,
    fileId,
    Math.max(0, positionSeconds),
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) ? durationSeconds : null,
  );
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

let transcodeAllJob = null;

app.get('/api/admin/transcode-all/status', authMiddleware(true), requireAdmin, (req, res) => {
  if (!transcodeAllJob) {
    return res.json({ running: false });
  }
  res.json({
    running: true,
    total: transcodeAllJob.total,
    done: transcodeAllJob.done,
    currentFileId: transcodeAllJob.currentFileId,
    startedAt: transcodeAllJob.startedAt,
  });
});

app.post('/api/admin/transcode-all', authMiddleware(true), requireAdmin, (req, res) => {
  if (transcodeAllJob) {
    return res.status(409).json({
      error: 'transcode_all_running',
      message: 'A full-library transcode is already in progress.',
      ...transcodeAllJob,
    });
  }
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  const { fileMap } = getLibrary();
  const fileIds = [...fileMap.keys()];
  const startedAt = Date.now();
  transcodeAllJob = { total: fileIds.length, done: 0, currentFileId: null, startedAt };
  res.json({
    ok: true,
    queued: fileIds.length,
    message:
      'Transcoding started in the background. Already-cached files are skipped quickly. Watch server logs for progress.',
  });

  void (async () => {
    try {
      for (let i = 0; i < fileIds.length; i++) {
        const fileId = fileIds[i];
        transcodeAllJob.currentFileId = fileId;
        try {
          await ensureVodHls(fileId);
          transcodeAllJob.done = i + 1;
          console.log(`[transcode-all] ${i + 1}/${fileIds.length} ok ${fileId}`);
        } catch (e) {
          transcodeAllJob.done = i + 1;
          console.error(`[transcode-all] ${i + 1}/${fileIds.length} fail ${fileId}`, e?.message || e);
        }
      }
      console.log('[transcode-all] batch finished');
    } finally {
      transcodeAllJob = null;
    }
  })();
});

app.get('/api/admin/users', authMiddleware(true), requireAdmin, (req, res) => {
  const rows = db
    .prepare(`SELECT id, username, role, must_change_password, created_at FROM users ORDER BY id`)
    .all();
  res.json({ users: rows });
});

app.post('/api/admin/users', authMiddleware(true), requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'username and password (min 8) required' });
  }
  const r = role === 'admin' ? 'admin' : 'user';
  const password_hash = bcrypt.hashSync(String(password), 12);
  try {
    db.prepare(
      `INSERT INTO users (username, password_hash, role, must_change_password, created_at)
       VALUES (?, ?, ?, 0, datetime('now'))`,
    ).run(String(username), password_hash, r);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username taken' });
    }
    throw e;
  }
  const user = db.prepare(`SELECT id, username, role, created_at FROM users WHERE username = ?`).get(String(username));
  res.status(201).json({ user });
});

app.delete('/api/admin/users/:id', authMiddleware(true), requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id === req.user.id) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const target = db.prepare(`SELECT id, role FROM users WHERE id = ?`).get(id);
  if (!target) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (target.role === 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`).get().c;
    if (admins <= 1) {
      return res.status(400).json({ error: 'Cannot delete last admin' });
    }
  }
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  res.status(204).end();
});

app.get('/api/vod/playable/:fileId', authMiddleware(true), (req, res) => {
  const fileId = String(req.params.fileId || '');
  if (!/^[0-9a-f]{32}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid fileId' });
  }
  if (!getFileMeta(fileId)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (isVodHlsPlayable(fileId)) {
    return res.json({ playable: true });
  }
  void ensureVodHls(fileId).catch((e) => {
    if (e?.code !== 'NOT_FOUND') console.error('[vod]', e);
  });
  res.json({ playable: false });
});

async function vodEnsureHandler(req, res, next) {
  const m = req.path.match(/^\/([0-9a-f]{32})\/(index\.m3u8|segment\d+\.ts)$/);
  if (!m) {
    return next();
  }
  const fileId = m[1];
  try {
    if (m[2] === 'index.m3u8') {
      if (!getFileMeta(fileId)) {
        return res.status(404).end();
      }
      if (!isVodHlsPlayable(fileId)) {
        void ensureVodHls(fileId).catch((e) => {
          if (e?.code !== 'NOT_FOUND') console.error('[vod]', e);
        });
        res.setHeader('Retry-After', '2');
        return res.status(503).json({ error: 'not_ready', message: 'Transcoding in progress.' });
      }
      return next();
    }
    await ensureVodHls(fileId);
    next();
  } catch (e) {
    if (e.code === 'NOT_FOUND') {
      return res.status(404).end();
    }
    console.error('[vod]', e);
    return res.status(500).json({ error: 'Transcode failed' });
  }
}

app.use('/hls/vod', authMiddleware(true), vodEnsureHandler, express.static(HLS_VOD_DIR));
app.use('/hls/live', authMiddleware(true), express.static('/var/hls/live'));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/hls')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP listening on ${PORT}`);
});
