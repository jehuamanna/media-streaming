import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { VideoPlayer } from '../components/VideoPlayer';

type Item = {
  id: string;
  title: string;
  hlsUrl: string;
  rootId: string;
  playlistId: string;
};

type Playlist = { id: string; name: string; items: Item[] };
type Root = { id: string; name: string; playlists: Playlist[] };

export default function Course() {
  const { rootId: rootIdParam } = useParams<{ rootId: string }>();
  const [searchParams] = useSearchParams();
  const rootId = rootIdParam ? decodeURIComponent(rootIdParam) : '';
  const playFileId = searchParams.get('play');
  const [root, setRoot] = useState<Root | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [bookmarked, setBookmarked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<Item[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);

  const flatItems = useMemo(() => {
    if (!root) return [];
    const out: Item[] = [];
    for (const pl of root.playlists) {
      for (const it of pl.items) out.push(it);
    }
    return out;
  }, [root]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ roots: Root[] }>('/api/library');
        const found = r.roots.find((x) => x.id === rootId);
        setRoot(found || null);
        if (!found) setError('Course not found');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
  }, [rootId]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ progress: { fileId: string; positionSeconds: number }[] }>(
          '/api/progress?limit=200',
        );
        const m: Record<string, number> = {};
        for (const p of r.progress) m[p.fileId] = p.positionSeconds;
        setProgressMap(m);
      } catch {
        /* ignore */
      }
    })();
  }, [rootId]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ bookmarks: { fileId: string }[] }>('/api/bookmarks');
        setBookmarked(new Set(r.bookmarks.map((b) => b.fileId)));
      } catch {
        /* ignore */
      }
    })();
  }, [rootId]);

  const playItem = useCallback((it: Item, all: Item[]) => {
    setQueue(all);
    const idx = all.findIndex((x) => x.id === it.id);
    setQueueIndex(idx >= 0 ? idx : 0);
  }, []);

  const defaultedFirstRef = useRef(false);
  useEffect(() => {
    defaultedFirstRef.current = false;
  }, [rootId]);

  useEffect(() => {
    if (!root || playFileId) return;
    if (flatItems.length === 0) return;
    if (defaultedFirstRef.current) return;
    defaultedFirstRef.current = true;
    playItem(flatItems[0], flatItems);
  }, [root, playFileId, flatItems, playItem]);

  useEffect(() => {
    if (!root || !playFileId) return;
    const all: Item[] = [];
    for (const pl of root.playlists) {
      for (const it of pl.items) all.push(it);
    }
    const it = all.find((x) => x.id === playFileId);
    if (it) playItem(it, all);
  }, [root, playFileId, playItem]);

  const current = queue[queueIndex] || null;
  const nextInQueue = queue[queueIndex + 1] ?? null;

  const onEnded = useCallback(() => {
    setQueueIndex((i) => (i + 1 < queue.length ? i + 1 : i));
  }, [queue.length]);

  async function toggleBookmark(fileId: string) {
    try {
      if (bookmarked.has(fileId)) {
        await api(`/api/bookmarks/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
        setBookmarked((prev) => {
          const n = new Set(prev);
          n.delete(fileId);
          return n;
        });
      } else {
        await api('/api/bookmarks', { method: 'POST', json: { fileId } });
        setBookmarked((prev) => new Set(prev).add(fileId));
      }
    } catch {
      /* ignore */
    }
  }

  if (error && !root) {
    return (
      <div className="app-shell">
        <div className="error">{error}</div>
        <Link to="/">Back</Link>
      </div>
    );
  }

  if (!root) {
    return (
      <div className="app-shell">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <p>
        <Link to="/">Courses</Link>
        <span style={{ color: 'var(--muted)' }}> / {root.name}</span>
      </p>
      <div className="course-layout">
        <div>
          <VideoPlayer
            src={current ? current.hlsUrl : null}
            fileId={current?.id ?? null}
            nextSrc={nextInQueue?.hlsUrl ?? null}
            nextFileId={nextInQueue?.id ?? null}
            onEnded={onEnded}
          />
          {current ? (
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 200 }}>{current.title}</span>
              <button type="button" className="btn btn-ghost" onClick={() => toggleBookmark(current.id)}>
                {bookmarked.has(current.id) ? 'Remove bookmark' : 'Bookmark'}
              </button>
            </div>
          ) : null}
        </div>
        <aside className="side-panel">
          <h3>Videos</h3>
          {root.playlists.map((pl) => (
            <div key={pl.id} className="playlist-section">
              <div className="pl-name">{pl.name}</div>
              {pl.items.map((it) => {
                const hasProg = (progressMap[it.id] ?? 0) > 2;
                return (
                  <button
                    key={it.id}
                    type="button"
                    className={`video-row ${current?.id === it.id ? 'active' : ''}`}
                    onClick={() => playItem(it, flatItems)}
                  >
                    {hasProg ? <span className="badge">Continue</span> : null}
                    <span style={{ flex: 1 }}>{it.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
