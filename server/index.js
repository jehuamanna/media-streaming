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
      items.sort((a, b) => a.title.localeCompare(b.title));
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
    rootItems.sort((a, b) => a.title.localeCompare(b.title));
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
  let cacheOk = false;
  try {
    const st = fs.statSync(indexPath);
    if (st.mtimeMs >= srcMtime) cacheOk = true;
  } catch {
    cacheOk = false;
  }
  if (cacheOk) return Promise.resolve(outDir);

  const existing = vodLocks.get(fileId);
  if (existing) return existing;

  const p = new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const tmpDir = path.join(outDir, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpM3u8 = path.join(tmpDir, 'index.m3u8');
    const args = [
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
      path.join(tmpDir, 'segment%03d.ts'),
      tmpM3u8,
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    ff.on('error', (e) => reject(e));
    ff.on('close', (code) => {
      vodLocks.delete(fileId);
      if (code !== 0) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        const err = new Error(stderr.slice(-500) || `ffmpeg exited ${code}`);
        err.code = 'FFMPEG';
        reject(err);
        return;
      }
      try {
        for (const name of fs.readdirSync(tmpDir)) {
          fs.renameSync(path.join(tmpDir, name), path.join(outDir, name));
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
        reject(e);
        return;
      }
      resolve(outDir);
    });
  });
  vodLocks.set(fileId, p);
  return p;
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

async function vodEnsureHandler(req, res, next) {
  const m = req.path.match(/^\/([0-9a-f]{32})\/(index\.m3u8|segment\d+\.ts)$/);
  if (!m) {
    return next();
  }
  const fileId = m[1];
  try {
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
