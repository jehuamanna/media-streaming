import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import Fuse from 'fuse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8020);
const VIDEOS_DIR = process.env.VIDEOS_DIR || '/streaming/Videos';
const HLS_VOD_DIR = process.env.HLS_VOD_DIR || '/var/hls/vod';
/**
 * sidecar (default): HLS next to each source file as <basename>.hls/ (persists with the media folder; requires write access under VIDEOS_DIR).
 * central: HLS under HLS_VOD_DIR/<fileId>/ (e.g. read-only library mount + writable HLS volume).
 */
const VOD_HLS_LAYOUT =
  String(process.env.VOD_HLS_LAYOUT || 'sidecar').toLowerCase() === 'central' ? 'central' : 'sidecar';
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
      if (e.name.endsWith('.hls')) continue;
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

function walkPdfFiles(dir, onFile) {
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
      if (e.name.endsWith('.hls')) continue;
      walkPdfFiles(full, onFile);
    } else if (e.isFile() && path.extname(e.name).toLowerCase() === '.pdf') {
      const relFromVideos = path.relative(VIDEOS_DIR, full).replace(/\\/g, '/');
      onFile(full, relFromVideos);
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
  let rootDirs = [];
  try {
    rootDirs = fs
      .readdirSync(VIDEOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.error('[buildLibrary] cannot read VIDEOS_DIR', VIDEOS_DIR, e);
    return { roots, fileMap };
  }

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
          kind: 'video',
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
        kind: 'video',
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

    const pdfs = [];
    for (const pl of plEntries) {
      if (!pl.isDirectory() || pl.name.startsWith('.')) continue;
      const playlistPath = path.join(rootPath, pl.name);
      walkPdfFiles(playlistPath, (absPath, relFromVideos) => {
        const fileId = hashFileKey(relFromVideos);
        const title = path.basename(absPath);
        pdfs.push({
          id: fileId,
          title,
          relativePath: relFromVideos,
          playlistId: pl.name,
        });
        fileMap.set(fileId, {
          absPath,
          relFromVideos,
          rootId: rootName,
          playlistId: pl.name,
          title,
          kind: 'pdf',
        });
      });
    }
    for (const ent of plEntries) {
      if (!ent.isFile() || ent.name.startsWith('.')) continue;
      if (path.extname(ent.name).toLowerCase() !== '.pdf') continue;
      const absPath = path.join(rootPath, ent.name);
      let relFromVideos;
      try {
        relFromVideos = path.relative(VIDEOS_DIR, absPath).replace(/\\/g, '/');
      } catch {
        continue;
      }
      const fileId = hashFileKey(relFromVideos);
      pdfs.push({
        id: fileId,
        title: ent.name,
        relativePath: relFromVideos,
        playlistId: '__root__',
      });
      fileMap.set(fileId, {
        absPath,
        relFromVideos,
        rootId: rootName,
        playlistId: '__root__',
        title: ent.name,
        kind: 'pdf',
      });
    }
    pdfs.sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    );

    let hasMaterialsZip = false;
    try {
      const zp = path.join(rootPath, 'code.zip');
      const st = fs.statSync(zp);
      hasMaterialsZip = st.isFile();
    } catch {
      hasMaterialsZip = false;
    }

    roots.push({
      id: rootName,
      name: rootName,
      playlists,
      itemCount,
      pdfs,
      hasMaterialsZip,
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

function resolveVodHlsOutDir(fileId, meta) {
  if (!meta || meta.kind === 'pdf') return null;
  if (VOD_HLS_LAYOUT === 'sidecar') {
    return path.join(path.dirname(meta.absPath), `${path.basename(meta.absPath)}.hls`);
  }
  return path.join(HLS_VOD_DIR, fileId);
}

const vodLocks = new Map();
const vodFfmpegByFileId = new Map();
const vodCancelRequested = new Set();

function clearVodHlsCache(fileId) {
  const meta = getFileMeta(fileId);
  if (!meta || meta.kind === 'pdf') return false;
  vodCancelRequested.add(fileId);
  const ff = vodFfmpegByFileId.get(fileId);
  if (ff && ff.exitCode === null) {
    try {
      ff.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  const outDir = resolveVodHlsOutDir(fileId, meta);
  if (outDir) {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  vodEncodeLastError.delete(fileId);
  if (!vodLocks.has(fileId)) {
    vodCancelRequested.delete(fileId);
  }
  return true;
}

function videoFileIdsForRoot(root) {
  const ids = [];
  for (const pl of root.playlists) {
    for (const it of pl.items) ids.push(it.id);
  }
  return ids;
}

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
/** After a failed transcode, do not auto-restart this often (playable poll used to spawn ffmpeg every ~1.5s). */
const VOD_ENCODE_RETRY_COOLDOWN_MS =
  Number.parseInt(String(process.env.VOD_ENCODE_RETRY_COOLDOWN_MS || ''), 10) || 60_000;

/** fileId -> last ffmpeg failure (surfaced on /api/vod/playable; cleared on success). */
const vodEncodeLastError = new Map();

function vodTranscodeCooldownActive(fileId) {
  const e = vodEncodeLastError.get(fileId);
  return Boolean(
    e && e.code !== 'CANCELLED' && Date.now() - e.at < VOD_ENCODE_RETRY_COOLDOWN_MS,
  );
}

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

function segmentFileExists(outDir, uriLine) {
  const t = uriLine.trim();
  if (!t || t.startsWith('#')) return false;
  const segPath = path.isAbsolute(t) ? t : path.join(outDir, t);
  try {
    return fs.existsSync(segPath) && fs.statSync(segPath).size > 0;
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
  const outDir = resolveVodHlsOutDir(fileId, meta);
  if (!outDir) return false;
  const indexPath = path.join(outDir, 'index.m3u8');
  if (!vodIndexFresh(indexPath, srcMtime)) return false;
  try {
    const txt = fs.readFileSync(indexPath, 'utf8');
    if (!txt.includes('#EXTINF')) return false;
    const lines = txt.split(/\r?\n/);
    for (const line of lines) {
      if (segmentFileExists(outDir, line)) return true;
    }
    const names = fs.readdirSync(outDir);
    for (const name of names) {
      if (!name.endsWith('.ts')) continue;
      const p = path.join(outDir, name);
      try {
        if (fs.statSync(p).size > 0) return true;
      } catch {
        /* keep scanning */
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

async function waitForVodFromPeer(fileId, outDir) {
  const deadline = Date.now() + VOD_PLAYABLE_WAIT_MS;
  const lockP = vodEncodingLockPath(fileId);
  while (Date.now() < deadline) {
    if (isVodHlsPlayable(fileId)) {
      return outDir;
    }
    if (!fs.existsSync(lockP)) {
      await new Promise((r) => setTimeout(r, 100));
      return ensureVodHls(fileId, { ignoreCooldown: true });
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
          if (segmentFileExists(outDir, line)) {
            clearInterval(iv);
            resolve();
            return;
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

function ensureVodHls(fileId, opts = {}) {
  const meta = getFileMeta(fileId);
  if (!meta) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    return Promise.reject(err);
  }
  if (meta.kind === 'pdf') {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    return Promise.reject(err);
  }
  const outDir = resolveVodHlsOutDir(fileId, meta);
  if (!outDir) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    return Promise.reject(err);
  }
  try {
    fs.statSync(meta.absPath);
  } catch {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    return Promise.reject(err);
  }
  // Admin "transcode" may pass force to rebuild even when cache looks playable.
  if (!opts.force && isVodHlsPlayable(fileId)) {
    vodEncodeLastError.delete(fileId);
    return Promise.resolve(outDir);
  }

  const existing = vodLocks.get(fileId);
  if (existing) return existing;

  if (!opts.ignoreCooldown && vodTranscodeCooldownActive(fileId)) {
    const prev = vodEncodeLastError.get(fileId);
    const err = new Error(prev?.message || 'Transcode failed; retry later.');
    err.code = 'ENCODE_COOLDOWN';
    return Promise.reject(err);
  }

  const releaseEncodingLock = tryAcquireEncodingLock(fileId);
  if (!releaseEncodingLock) {
    return waitForVodFromPeer(fileId, outDir);
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
    if (vodCancelRequested.delete(fileId)) {
      try {
        releaseEncodingLock();
      } catch {
        /* ignore */
      }
      releaseVodTranscodeSlot();
      vodLocks.delete(fileId);
      const err = new Error('Cancelled');
      err.code = 'CANCELLED';
      settleHttp(err);
      return;
    }
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      ff = spawn('ffmpeg', ffmpegVodArgs(meta, outDir), { stdio: ['ignore', 'ignore', 'pipe'] });
      vodFfmpegByFileId.set(fileId, ff);
      ff.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      const spawnOrRunError = new Promise((_, rej) => {
        ff.once('error', rej);
      });
      await Promise.race([waitForPlayableHls(outDir, ff, VOD_PLAYABLE_WAIT_MS), spawnOrRunError]);
      vodEncodeLastError.delete(fileId);
      settleHttp(null, outDir);

      await waitForFfmpegClose(ff, stderr);
    } catch (e) {
      if (e?.code !== 'CANCELLED') {
        vodEncodeLastError.set(fileId, {
          message: e?.message || String(e),
          code: e?.code || 'FAILED',
          at: Date.now(),
        });
      }
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
      vodFfmpegByFileId.delete(fileId);
      vodCancelRequested.delete(fileId);
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
    CREATE TABLE IF NOT EXISTS library_hidden_course (
      root_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS library_hidden_playlist (
      root_id TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      PRIMARY KEY (root_id, playlist_id)
    );
    CREATE TABLE IF NOT EXISTS library_hidden_video (
      file_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS course_metadata (
      root_id TEXT PRIMARY KEY,
      category TEXT,
      category_url TEXT,
      added_at TEXT,
      language TEXT,
      description_markdown TEXT,
      tags TEXT,
      categories TEXT
    );
    CREATE TABLE IF NOT EXISTS media_duration (
      file_id TEXT PRIMARY KEY,
      duration_seconds REAL NOT NULL,
      source_mtime_ms REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_user_hidden_course (
      user_id INTEGER NOT NULL,
      root_id TEXT NOT NULL,
      PRIMARY KEY (user_id, root_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS library_user_hidden_playlist (
      user_id INTEGER NOT NULL,
      root_id TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      PRIMARY KEY (user_id, root_id, playlist_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS library_user_hidden_video (
      user_id INTEGER NOT NULL,
      file_id TEXT NOT NULL,
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

  const courseMetaCols = db.prepare(`PRAGMA table_info(course_metadata)`).all();
  if (!courseMetaCols.some((c) => c.name === 'tags')) {
    db.exec(`ALTER TABLE course_metadata ADD COLUMN tags TEXT`);
  }
  if (!courseMetaCols.some((c) => c.name === 'categories')) {
    db.exec(`ALTER TABLE course_metadata ADD COLUMN categories TEXT`);
  }

  return db;
}

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET must be set and at least 16 characters.');
  process.exit(1);
}

const db = initDb();

function normalizeCourseTagsInput(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const x of input) {
    const s = String(x).trim();
    if (!s || s.length > 64) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

function parseCourseTagsColumn(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    return normalizeCourseTagsInput(v);
  } catch {
    return [];
  }
}

function normalizeCourseCategoriesInput(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    let name = '';
    let url = null;
    if (typeof item === 'string') {
      name = String(item).trim();
    } else if (item && typeof item === 'object') {
      name = String(item.name ?? item.label ?? '').trim();
      const u = item.url ?? item.categoryUrl;
      if (u != null && String(u).trim()) url = String(u).trim().slice(0, 2048);
    }
    if (!name || name.length > 128) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name, url });
    if (out.length >= 20) break;
  }
  return out;
}

function parseCourseCategoriesColumn(row) {
  if (row.categories != null && row.categories !== '') {
    try {
      const v = JSON.parse(row.categories);
      const norm = normalizeCourseCategoriesInput(v);
      if (norm.length > 0) return norm;
    } catch {
      /* fall through */
    }
  }
  const c = String(row.category || '').trim();
  if (c) {
    const u =
      row.category_url != null && String(row.category_url).trim()
        ? String(row.category_url).trim().slice(0, 2048)
        : null;
    return [{ name: c, url: u }];
  }
  return [];
}

function loadVisibilityState() {
  const hiddenCourses = new Set(
    db.prepare('SELECT root_id FROM library_hidden_course').all().map((r) => r.root_id),
  );
  const hiddenPlaylists = new Map();
  for (const row of db.prepare('SELECT root_id, playlist_id FROM library_hidden_playlist').all()) {
    if (!hiddenPlaylists.has(row.root_id)) hiddenPlaylists.set(row.root_id, new Set());
    hiddenPlaylists.get(row.root_id).add(row.playlist_id);
  }
  const hiddenVideos = new Set(
    db.prepare('SELECT file_id FROM library_hidden_video').all().map((r) => r.file_id),
  );
  return { hiddenCourses, hiddenPlaylists, hiddenVideos };
}

function loadUserVisibilityState(userId) {
  const hiddenCourses = new Set(
    db
      .prepare('SELECT root_id FROM library_user_hidden_course WHERE user_id = ?')
      .all(userId)
      .map((r) => r.root_id),
  );
  const hiddenPlaylists = new Map();
  for (const row of db
    .prepare(
      'SELECT root_id, playlist_id FROM library_user_hidden_playlist WHERE user_id = ?',
    )
    .all(userId)) {
    if (!hiddenPlaylists.has(row.root_id)) hiddenPlaylists.set(row.root_id, new Set());
    hiddenPlaylists.get(row.root_id).add(row.playlist_id);
  }
  const hiddenVideos = new Set(
    db
      .prepare('SELECT file_id FROM library_user_hidden_video WHERE user_id = ?')
      .all(userId)
      .map((r) => r.file_id),
  );
  return { hiddenCourses, hiddenPlaylists, hiddenVideos };
}

function mergeVisibility(globalVis, userVis) {
  const hiddenCourses = new Set([...globalVis.hiddenCourses, ...userVis.hiddenCourses]);
  const hiddenVideos = new Set([...globalVis.hiddenVideos, ...userVis.hiddenVideos]);
  const hiddenPlaylists = new Map(globalVis.hiddenPlaylists);
  for (const [rootId, plSet] of userVis.hiddenPlaylists) {
    if (!hiddenPlaylists.has(rootId)) hiddenPlaylists.set(rootId, new Set());
    for (const pl of plSet) hiddenPlaylists.get(rootId).add(pl);
  }
  return { hiddenCourses, hiddenPlaylists, hiddenVideos };
}

function loadMergedVisibilityForUser(userId) {
  const g = loadVisibilityState();
  if (!userId) return g;
  const u = loadUserVisibilityState(userId);
  return mergeVisibility(g, u);
}

function playlistHiddenForRoot(vis, rootId, playlistId) {
  return vis.hiddenPlaylists.get(rootId)?.has(playlistId) ?? false;
}

function filterRootsForLearner(roots, vis) {
  const out = [];
  for (const root of roots) {
    if (vis.hiddenCourses.has(root.id)) continue;
    const playlists = [];
    for (const pl of root.playlists) {
      if (playlistHiddenForRoot(vis, root.id, pl.id)) continue;
      const items = pl.items.filter((it) => !vis.hiddenVideos.has(it.id));
      playlists.push({ ...pl, items });
    }
    const pdfs = (root.pdfs || []).filter((pdf) => {
      if (vis.hiddenVideos.has(pdf.id)) return false;
      if (playlistHiddenForRoot(vis, root.id, pdf.playlistId)) return false;
      return true;
    });
    const videoCount = playlists.reduce((n, p) => n + p.items.length, 0);
    if (videoCount === 0 && pdfs.length === 0) continue;
    let courseKind = 'video';
    if (videoCount === 0 && pdfs.length > 0) courseKind = 'pdf';
    else if (videoCount > 0 && pdfs.length > 0) courseKind = 'mixed';
    out.push({
      ...root,
      playlists,
      pdfs,
      itemCount: videoCount,
      pdfCount: pdfs.length,
      courseKind,
    });
  }
  return out;
}

function enrichRootForLibrary(root) {
  const row = db.prepare('SELECT * FROM course_metadata WHERE root_id = ?').get(root.id);
  const courseMeta = row
    ? {
        categories: parseCourseCategoriesColumn(row),
        addedAt: row.added_at || null,
        descriptionMarkdown: row.description_markdown || null,
        tags: parseCourseTagsColumn(row.tags),
      }
    : null;
  const videoIds = [];
  for (const pl of root.playlists) {
    for (const it of pl.items) videoIds.push(it.id);
  }
  let durationSecondsTotal = null;
  if (videoIds.length > 0) {
    const stmt = db.prepare('SELECT duration_seconds FROM media_duration WHERE file_id = ?');
    let sum = 0;
    let n = 0;
    for (const id of videoIds) {
      const r = stmt.get(id);
      if (r) {
        sum += r.duration_seconds;
        n++;
      }
    }
    if (n > 0) durationSecondsTotal = sum;
  }
  const pdfs = (root.pdfs || []).map((p) => ({
    id: p.id,
    title: p.title,
    relativePath: p.relativePath,
    playlistId: p.playlistId,
    url: `/api/documents/${p.id}`,
  }));
  return {
    id: root.id,
    name: root.name,
    playlists: root.playlists,
    itemCount: root.itemCount,
    pdfCount: root.pdfCount,
    courseKind: root.courseKind,
    hasMaterialsZip: root.hasMaterialsZip,
    pdfs,
    courseMeta,
    durationSecondsTotal,
  };
}

function slugifyDownloadName(name) {
  const s = String(name)
    .replace(/[^\w\-.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return s || 'course';
}

function isDocumentVisibleToLearner(fileId, userId) {
  const meta = getFileMeta(fileId);
  if (!meta || meta.kind !== 'pdf') return false;
  const vis = loadMergedVisibilityForUser(userId);
  if (vis.hiddenCourses.has(meta.rootId)) return false;
  if (playlistHiddenForRoot(vis, meta.rootId, meta.playlistId)) return false;
  if (vis.hiddenVideos.has(fileId)) return false;
  return true;
}

function isCourseMaterialsAllowed(rootId, userId) {
  const vis = loadMergedVisibilityForUser(userId);
  return !vis.hiddenCourses.has(rootId) && fs.existsSync(path.join(VIDEOS_DIR, rootId));
}

function isMediaFileVisibleToLearner(fileId, userId) {
  const meta = getFileMeta(fileId);
  if (!meta || (meta.kind !== 'pdf' && meta.kind !== 'video')) return false;
  const vis = loadMergedVisibilityForUser(userId);
  if (vis.hiddenCourses.has(meta.rootId)) return false;
  if (playlistHiddenForRoot(vis, meta.rootId, meta.playlistId)) return false;
  if (vis.hiddenVideos.has(fileId)) return false;
  return true;
}

function ffprobeDurationSeconds(absPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      absPath,
    ]);
    let out = '';
    let errBuf = '';
    ff.stdout?.on('data', (d) => {
      out += d.toString();
    });
    ff.stderr?.on('data', (d) => {
      errBuf += d.toString();
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errBuf || `ffprobe exit ${code}`));
        return;
      }
      const v = parseFloat(String(out).trim());
      resolve(Number.isFinite(v) ? v : null);
    });
  });
}

function buildSearchIndex(roots) {
  const entries = [];
  for (const root of roots) {
    const tagPart = Array.isArray(root.courseMeta?.tags)
      ? root.courseMeta.tags.join(' ')
      : '';
    const catPart = Array.isArray(root.courseMeta?.categories)
      ? root.courseMeta.categories
          .map((c) => (c && c.name ? String(c.name) : ''))
          .filter(Boolean)
          .join(' ')
      : '';
    entries.push({
      type: 'course',
      label: root.name,
      path: [root.name, tagPart, catPart].filter(Boolean).join(' '),
      rootId: root.id,
      fileId: null,
      playlistId: null,
    });
    for (const pl of root.playlists) {
      for (const it of pl.items) {
        entries.push({
          type: 'video',
          label: it.title,
          path: `${root.name}/${pl.name}/${it.title}`,
          rootId: root.id,
          fileId: it.id,
          playlistId: pl.id,
        });
      }
    }
    for (const p of root.pdfs || []) {
      entries.push({
        type: 'pdf',
        label: p.title,
        path: p.relativePath.replace(/\\/g, '/'),
        rootId: root.id,
        fileId: p.id,
        playlistId: p.playlistId,
      });
    }
  }
  return entries;
}

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
  getLibrary();
  const roots = libraryCache.data.roots;
  const vis = loadMergedVisibilityForUser(req.user.id);
  const filtered = filterRootsForLearner(roots, vis);
  res.json({ roots: filtered.map(enrichRootForLibrary) });
});

app.get('/api/search', authMiddleware(true), (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(30, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
  if (q.length < 1) return res.json({ results: [] });
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  getLibrary();
  const vis = loadMergedVisibilityForUser(req.user.id);
  const roots = filterRootsForLearner(libraryCache.data.roots, vis).map(enrichRootForLibrary);
  const idx = buildSearchIndex(roots);
  const fuse = new Fuse(idx, { keys: ['label', 'path'], threshold: 0.42, ignoreLocation: true });
  const hits = fuse.search(q, { limit }).map((h) => h.item);
  res.json({ results: hits.slice(0, limit) });
});

app.get('/api/similar-courses', authMiddleware(true), (req, res) => {
  const rootId = decodeURIComponent(String(req.query.rootId || ''));
  const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit || '8'), 10) || 8));
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  getLibrary();
  const vis = loadMergedVisibilityForUser(req.user.id);
  const enriched = filterRootsForLearner(libraryCache.data.roots, vis).map(enrichRootForLibrary);
  const current = enriched.find((r) => r.id === rootId);
  if (!current) return res.json({ courses: [] });
  const others = enriched.filter((r) => r.id !== rootId);
  const curCatSet = new Set(
    (current.courseMeta?.categories || [])
      .map((c) => (c && c.name ? String(c.name).trim().toLowerCase() : ''))
      .filter(Boolean),
  );
  const curTagSet = new Set(
    (current.courseMeta?.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
  );
  const fuse = new Fuse(others, { keys: ['name'], threshold: 0.52, includeScore: true });
  const nameResults = fuse.search(current.name, { limit: 40 });
  const byId = new Map();
  for (const o of others) {
    let score = 0;
    let sharedCats = 0;
    for (const c of o.courseMeta?.categories || []) {
      const k = c && c.name ? String(c.name).trim().toLowerCase() : '';
      if (k && curCatSet.has(k)) sharedCats += 1;
    }
    if (sharedCats > 0) score += 1000 + 200 * (sharedCats - 1);
    for (const t of o.courseMeta?.tags || []) {
      const k = String(t).trim().toLowerCase();
      if (k && curTagSet.has(k)) score += 200;
    }
    byId.set(o.id, { o, score });
  }
  for (const fr of nameResults) {
    const id = fr.item.id;
    const entry = byId.get(id);
    if (entry) {
      const fs = fr.score ?? 1;
      entry.score += 400 / (1 + fs);
    }
  }
  const sorted = [...byId.values()].sort((a, b) => b.score - a.score);
  const courses = sorted.slice(0, limit).map(({ o }) => ({
    id: o.id,
    name: o.name,
    itemCount: o.itemCount,
    pdfCount: o.pdfCount,
    courseKind: o.courseKind,
    courseMeta: o.courseMeta,
  }));
  res.json({ courses });
});

app.get('/api/documents/:fileId', authMiddleware(true), (req, res) => {
  const fileId = String(req.params.fileId || '');
  if (!/^[0-9a-f]{32}$/.test(fileId)) return res.status(400).end();
  if (!isDocumentVisibleToLearner(fileId, req.user.id)) return res.status(403).end();
  const meta = getFileMeta(fileId);
  if (!meta || meta.kind !== 'pdf') return res.status(404).end();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.title)}`);
  res.sendFile(path.resolve(meta.absPath));
});

app.get('/api/course/:rootId/materials.zip', authMiddleware(true), (req, res) => {
  const rootId = decodeURIComponent(req.params.rootId);
  if (rootId.includes('..') || rootId.includes('/') || rootId.includes('\\')) {
    return res.status(400).end();
  }
  if (!isCourseMaterialsAllowed(rootId, req.user.id)) return res.status(404).end();
  const base = path.resolve(path.join(VIDEOS_DIR, rootId));
  const rootResolved = path.resolve(VIDEOS_DIR);
  if (!base.startsWith(rootResolved + path.sep) && base !== rootResolved) return res.status(400).end();
  const zipPath = path.join(base, 'code.zip');
  const resolved = path.resolve(zipPath);
  if (!resolved.startsWith(base + path.sep)) return res.status(404).end();
  if (!fs.existsSync(resolved)) return res.status(404).end();
  const name = `${slugifyDownloadName(rootId)}-code.zip`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(resolved);
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
  const progMeta = getFileMeta(fileId);
  if (!progMeta || progMeta.kind === 'pdf') {
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
  const fileIds = [...fileMap.entries()]
    .filter(([, m]) => m.kind !== 'pdf')
    .map(([id]) => id);
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
          await ensureVodHls(fileId, { ignoreCooldown: true });
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

function parseAdminFileIdParam(raw) {
  const s = decodeURIComponent(String(raw || ''));
  return /^[a-f0-9]{32}$/.test(s) ? s : null;
}

app.get('/api/admin/vod/overview', authMiddleware(true), requireAdmin, (req, res) => {
  try {
    libraryCache = { at: 0, data: null, fileMap: new Map() };
    const roots = getLibrary().data.roots;
    const body = roots.map((root) => ({
      id: root.id,
      name: root.name,
      playlists: root.playlists.map((pl) => ({
        id: pl.id,
        name: pl.name,
        items: pl.items.map((it) => ({
          id: it.id,
          title: it.title,
          ready: isVodHlsPlayable(it.id),
          busy: vodLocks.has(it.id),
        })),
      })),
    }));
    res.json({ roots: body });
  } catch (e) {
    console.error('[admin vod overview]', e?.message || e, e?.stack || '');
    res.status(503).json({
      error:
        'Video library overview failed. Check server logs. If the library is empty or wrong, verify VIDEOS_DIR exists and is readable.',
      code: 'library_overview_failed',
    });
  }
});

app.post('/api/admin/vod/transcode/:fileId', authMiddleware(true), requireAdmin, (req, res) => {
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  const fileId = parseAdminFileIdParam(req.params.fileId);
  if (!fileId) return res.status(400).json({ error: 'bad_file_id' });
  const m = getFileMeta(fileId);
  if (!m || m.kind === 'pdf') return res.status(404).json({ error: 'not_found' });
  vodEncodeLastError.delete(fileId);
  const pending = vodLocks.get(fileId);
  clearVodHlsCache(fileId);
  void (async () => {
    if (pending) {
      try {
        await pending;
      } catch {
        /* cancelled / failed prior run */
      }
    }
    await ensureVodHls(fileId, { ignoreCooldown: true, force: true }).catch((e) => {
      if (e?.code && e.code !== 'NOT_FOUND' && e.code !== 'CANCELLED')
        console.error('[admin vod transcode]', e);
    });
  })();
  res.json({ ok: true });
});

app.delete('/api/admin/vod/cache/:fileId', authMiddleware(true), requireAdmin, (req, res) => {
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  const fileId = parseAdminFileIdParam(req.params.fileId);
  if (!fileId) return res.status(400).json({ error: 'bad_file_id' });
  if (!clearVodHlsCache(fileId)) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/admin/vod/transcode-root/:rootId', authMiddleware(true), requireAdmin, (req, res) => {
  const rootId = decodeURIComponent(String(req.params.rootId || ''));
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  const roots = getLibrary().data.roots;
  const root = roots.find((r) => r.id === rootId);
  if (!root) return res.status(404).json({ error: 'not_found' });
  const ids = videoFileIdsForRoot(root);
  const force = Boolean(req.body && req.body.force);
  res.json({ ok: true, queued: ids.length, force });
  void (async () => {
    for (const id of ids) {
      try {
        await ensureVodHls(id, { ignoreCooldown: true, force });
      } catch (e) {
        if (e?.code !== 'CANCELLED') console.error(`[transcode-root] ${rootId} ${id}`, e?.message || e);
      }
    }
  })();
});

app.delete('/api/admin/vod/cache-root/:rootId', authMiddleware(true), requireAdmin, (req, res) => {
  const rootId = decodeURIComponent(String(req.params.rootId || ''));
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  const roots = getLibrary().data.roots;
  const root = roots.find((r) => r.id === rootId);
  if (!root) return res.status(404).json({ error: 'not_found' });
  const ids = videoFileIdsForRoot(root);
  let n = 0;
  for (const id of ids) {
    if (clearVodHlsCache(id)) n++;
  }
  res.json({ ok: true, cleared: n });
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

app.get('/api/admin/library-visibility', authMiddleware(true), requireAdmin, (req, res) => {
  libraryCache = { at: 0, data: null, fileMap: new Map() };
  getLibrary();
  const roots = libraryCache.data.roots;
  const forUserRaw = req.query.forUser;
  const forUserId =
    forUserRaw != null && String(forUserRaw).trim() !== ''
      ? parseInt(String(forUserRaw), 10)
      : NaN;
  const g = loadVisibilityState();
  const perUser = Number.isFinite(forUserId) && forUserId > 0;
  const m = perUser ? mergeVisibility(g, loadUserVisibilityState(forUserId)) : g;

  const body = roots.map((root) => ({
    id: root.id,
    name: root.name,
    hidden: m.hiddenCourses.has(root.id),
    globalHidden: perUser ? g.hiddenCourses.has(root.id) : undefined,
    playlists: root.playlists.map((pl) => ({
      id: pl.id,
      name: pl.name,
      hidden: playlistHiddenForRoot(m, root.id, pl.id),
      globalHidden: perUser ? playlistHiddenForRoot(g, root.id, pl.id) : undefined,
      items: pl.items.map((it) => ({
        id: it.id,
        title: it.title,
        hidden: m.hiddenVideos.has(it.id),
        globalHidden: perUser ? g.hiddenVideos.has(it.id) : undefined,
      })),
    })),
    pdfs: (root.pdfs || []).map((p) => ({
      id: p.id,
      title: p.title,
      hidden: m.hiddenVideos.has(p.id),
      globalHidden: perUser ? g.hiddenVideos.has(p.id) : undefined,
    })),
  }));
  res.json({ roots: body, scope: perUser ? 'user' : 'global', forUserId: perUser ? forUserId : null });
});

app.put('/api/admin/library-visibility', authMiddleware(true), requireAdmin, (req, res) => {
  const {
    hiddenCourses = [],
    hiddenPlaylists = [],
    hiddenVideos = [],
    forUser: forUserBody,
  } = req.body || {};
  const forUserId =
    forUserBody != null && forUserBody !== '' ? parseInt(String(forUserBody), 10) : NaN;
  const perUser = Number.isFinite(forUserId) && forUserId > 0;

  if (perUser) {
    const urow = db.prepare('SELECT id FROM users WHERE id = ?').get(forUserId);
    if (!urow) {
      return res.status(400).json({ error: 'Invalid forUser' });
    }
    const g = loadVisibilityState();
    const userCourses = hiddenCourses
      .map((id) => String(id))
      .filter((id) => !g.hiddenCourses.has(id));
    const userPl = [];
    for (const x of hiddenPlaylists) {
      if (x?.rootId == null || x?.playlistId == null) continue;
      const rootId = String(x.rootId);
      const playlistId = String(x.playlistId);
      if (!playlistHiddenForRoot(g, rootId, playlistId)) {
        userPl.push({ rootId, playlistId });
      }
    }
    const userVids = hiddenVideos.map((id) => String(id)).filter((id) => !g.hiddenVideos.has(id));
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM library_user_hidden_course WHERE user_id = ?').run(forUserId);
      db.prepare('DELETE FROM library_user_hidden_playlist WHERE user_id = ?').run(forUserId);
      db.prepare('DELETE FROM library_user_hidden_video WHERE user_id = ?').run(forUserId);
      const insC = db.prepare(
        'INSERT INTO library_user_hidden_course (user_id, root_id) VALUES (?, ?)',
      );
      const insP = db.prepare(
        'INSERT INTO library_user_hidden_playlist (user_id, root_id, playlist_id) VALUES (?, ?, ?)',
      );
      const insV = db.prepare(
        'INSERT INTO library_user_hidden_video (user_id, file_id) VALUES (?, ?)',
      );
      for (const id of userCourses) insC.run(forUserId, id);
      for (const x of userPl) insP.run(forUserId, x.rootId, x.playlistId);
      for (const id of userVids) insV.run(forUserId, id);
    });
    tx();
    return res.json({ ok: true });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM library_hidden_course').run();
    db.prepare('DELETE FROM library_hidden_playlist').run();
    db.prepare('DELETE FROM library_hidden_video').run();
    const insC = db.prepare('INSERT INTO library_hidden_course (root_id) VALUES (?)');
    const insP = db.prepare(
      'INSERT INTO library_hidden_playlist (root_id, playlist_id) VALUES (?, ?)',
    );
    const insV = db.prepare('INSERT INTO library_hidden_video (file_id) VALUES (?)');
    for (const id of hiddenCourses) insC.run(String(id));
    for (const x of hiddenPlaylists) {
      if (x?.rootId != null && x?.playlistId != null) {
        insP.run(String(x.rootId), String(x.playlistId));
      }
    }
    for (const id of hiddenVideos) insV.run(String(id));
  });
  tx();
  res.json({ ok: true });
});

app.get('/api/admin/course-metadata/:rootId', authMiddleware(true), requireAdmin, (req, res) => {
  const rootId = decodeURIComponent(req.params.rootId);
  const row = db.prepare('SELECT * FROM course_metadata WHERE root_id = ?').get(rootId);
  if (!row) {
    return res.json({
      rootId,
      categories: [],
      addedAt: '',
      descriptionMarkdown: '',
      tags: [],
    });
  }
  res.json({
    rootId: row.root_id,
    categories: parseCourseCategoriesColumn(row),
    addedAt: row.added_at || '',
    descriptionMarkdown: row.description_markdown || '',
    tags: parseCourseTagsColumn(row.tags),
  });
});

app.put('/api/admin/course-metadata/:rootId', authMiddleware(true), requireAdmin, (req, res) => {
  const rootId = decodeURIComponent(req.params.rootId);
  const { categories, addedAt, descriptionMarkdown, tags } = req.body || {};
  const categoriesNorm = normalizeCourseCategoriesInput(categories);
  const categoriesJson = categoriesNorm.length > 0 ? JSON.stringify(categoriesNorm) : null;
  const tagsNorm = normalizeCourseTagsInput(tags);
  const tagsJson = tagsNorm.length > 0 ? JSON.stringify(tagsNorm) : null;
  db.prepare(
    `INSERT INTO course_metadata (root_id, category, category_url, added_at, description_markdown, tags, categories)
     VALUES (?, NULL, NULL, ?, ?, ?, ?)
     ON CONFLICT(root_id) DO UPDATE SET
       category = NULL,
       category_url = NULL,
       added_at = excluded.added_at,
       description_markdown = excluded.description_markdown,
       tags = excluded.tags,
       categories = excluded.categories`,
  ).run(rootId, addedAt ?? null, descriptionMarkdown ?? null, tagsJson, categoriesJson);
  res.json({ ok: true });
});

app.post('/api/admin/media-duration/refresh', authMiddleware(true), requireAdmin, (req, res, next) => {
  void (async () => {
    try {
      libraryCache = { at: 0, data: null, fileMap: new Map() };
      getLibrary();
      const { fileMap } = libraryCache;
      const cap = Math.min(500, Math.max(1, parseInt(String(req.body?.cap || 200), 10) || 200));
      const list = [...fileMap.entries()].filter(([, m]) => m.kind !== 'pdf');
      let probed = 0;
      let errors = 0;
      for (let i = 0; i < Math.min(cap, list.length); i++) {
        const [fileId, m] = list[i];
        try {
          const mtime = fs.statSync(m.absPath).mtimeMs;
          const dur = await ffprobeDurationSeconds(m.absPath);
          if (dur != null && Number.isFinite(dur)) {
            db.prepare(
              `INSERT INTO media_duration (file_id, duration_seconds, source_mtime_ms, updated_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(file_id) DO UPDATE SET
                 duration_seconds = excluded.duration_seconds,
                 source_mtime_ms = excluded.source_mtime_ms,
                 updated_at = excluded.updated_at`,
            ).run(fileId, dur, mtime);
          }
          probed++;
        } catch {
          errors++;
        }
      }
      res.json({ ok: true, probed, errors, total: list.length });
    } catch (e) {
      next(e);
    }
  })();
});

app.get('/api/vod/playable/:fileId', authMiddleware(true), (req, res) => {
  const fileId = String(req.params.fileId || '');
  if (!/^[0-9a-f]{32}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid fileId' });
  }
  if (!getFileMeta(fileId)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!isMediaFileVisibleToLearner(fileId, req.user.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (isVodHlsPlayable(fileId)) {
    vodEncodeLastError.delete(fileId);
    return res.json({ playable: true });
  }
  const pending = vodLocks.has(fileId);
  if (!vodTranscodeCooldownActive(fileId)) {
    void ensureVodHls(fileId).catch((e) => {
      if (e?.code === 'NOT_FOUND' || e?.code === 'ENCODE_COOLDOWN') return;
      console.error('[vod]', e);
    });
  }
  const lastErr = vodEncodeLastError.get(fileId);
  const body = { playable: false, pending };
  if (lastErr && vodTranscodeCooldownActive(fileId)) {
    body.error = lastErr.message;
    body.errorCode = lastErr.code;
  }
  res.json(body);
});

async function vodEnsureHandler(req, res, next) {
  const m = req.path.match(/^\/([0-9a-f]{32})\/(index\.m3u8|segment\d+\.ts)$/);
  if (!m) {
    return next();
  }
  const fileId = m[1];
  try {
    if (!isMediaFileVisibleToLearner(fileId, req.user.id)) {
      return res.status(403).end();
    }
    if (m[2] === 'index.m3u8') {
      if (!getFileMeta(fileId)) {
        return res.status(404).end();
      }
      if (!isVodHlsPlayable(fileId)) {
        if (vodTranscodeCooldownActive(fileId)) {
          res.setHeader('Retry-After', '15');
          return res.status(503).json({
            error: 'transcode_failed',
            message: vodEncodeLastError.get(fileId)?.message || 'Transcode failed.',
          });
        }
        void ensureVodHls(fileId).catch((e) => {
          if (e?.code === 'NOT_FOUND' || e?.code === 'ENCODE_COOLDOWN') return;
          console.error('[vod]', e);
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
    if (e.code === 'ENCODE_COOLDOWN') {
      res.setHeader('Retry-After', '15');
      return res.status(503).json({
        error: 'transcode_failed',
        message: vodEncodeLastError.get(fileId)?.message || e.message,
      });
    }
    console.error('[vod]', e);
    return res.status(500).json({ error: 'Transcode failed' });
  }
}

function vodHlsRelativePath(req) {
  let p = req.path || '';
  if (p.startsWith('/hls/vod')) {
    p = p.slice('/hls/vod'.length) || '/';
  }
  return p;
}

function vodHlsStaticMiddleware(req, res, next) {
  if (VOD_HLS_LAYOUT === 'central') {
    express.static(HLS_VOD_DIR)(req, res, next);
    return;
  }
  const m = vodHlsRelativePath(req).match(/^\/([0-9a-f]{32})\/(.+)$/);
  if (!m) {
    return res.status(404).end();
  }
  const fileId = m[1];
  const assetRel = m[2];
  if (assetRel.includes('..') || path.isAbsolute(assetRel)) {
    return res.status(400).end();
  }
  const meta = getFileMeta(fileId);
  if (!meta) {
    return res.status(404).end();
  }
  const base = resolveVodHlsOutDir(fileId, meta);
  if (!base) {
    return res.status(404).end();
  }
  const resolvedBase = path.resolve(base);
  const filePath = path.resolve(resolvedBase, assetRel);
  const rel = path.relative(resolvedBase, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(403).end();
  }
  res.sendFile(filePath, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).end();
      }
      return next(err);
    }
  });
}

app.use('/hls/vod', authMiddleware(true), vodEnsureHandler, vodHlsStaticMiddleware);
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
  try {
    const vOk = fs.existsSync(VIDEOS_DIR);
    const hOk = fs.existsSync(HLS_VOD_DIR);
    console.log(
      `[config] VIDEOS_DIR=${VIDEOS_DIR} exists=${vOk} | HLS_VOD_DIR=${HLS_VOD_DIR} exists=${hOk} | VOD_HLS_LAYOUT=${VOD_HLS_LAYOUT}`,
    );
  } catch (e) {
    console.error('[config] could not stat media paths', e);
  }
});
