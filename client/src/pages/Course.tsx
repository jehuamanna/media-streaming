import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, apiBlob } from '../api';
import { VideoPlayer } from '../components/VideoPlayer';

type Item = {
  id: string;
  title: string;
  hlsUrl: string;
  rootId: string;
  playlistId: string;
};

type Playlist = { id: string; name: string; items: Item[] };

type PdfItem = {
  id: string;
  title: string;
  relativePath: string;
  playlistId: string;
  url: string;
};

type CourseCategory = { name: string; url: string | null };

type CourseMeta = {
  categories?: CourseCategory[];
  addedAt: string | null;
  descriptionMarkdown: string | null;
  tags?: string[];
};

type Root = {
  id: string;
  name: string;
  playlists: Playlist[];
  itemCount: number;
  pdfCount?: number;
  courseKind?: 'video' | 'pdf' | 'mixed';
  hasMaterialsZip?: boolean;
  pdfs?: PdfItem[];
  courseMeta?: CourseMeta | null;
  durationSecondsTotal?: number | null;
};

type SimilarCourse = {
  id: string;
  name: string;
  itemCount: number;
  pdfCount?: number;
  courseKind?: string;
  courseMeta?: CourseMeta | null;
};

function slugifyDownload(name: string) {
  return (
    String(name)
      .replace(/[^\w\-.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'course'
  );
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export default function Course() {
  const { rootId: rootIdParam } = useParams<{ rootId: string }>();
  const [searchParams] = useSearchParams();
  const rootId = rootIdParam ? decodeURIComponent(rootIdParam) : '';
  const playFileId = searchParams.get('play');
  const pdfParam = searchParams.get('pdf');
  const [root, setRoot] = useState<Root | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [bookmarked, setBookmarked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<Item[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [similar, setSimilar] = useState<SimilarCourse[]>([]);
  const [pdfFocus, setPdfFocus] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [materialsBusy, setMaterialsBusy] = useState(false);

  const flatItems = useMemo(() => {
    if (!root) return [];
    const out: Item[] = [];
    for (const pl of root.playlists) {
      for (const it of pl.items) out.push(it);
    }
    return out;
  }, [root]);

  const courseKind = root?.courseKind ?? (flatItems.length ? 'video' : 'pdf');
  const showVideo = courseKind === 'video' || courseKind === 'mixed';
  const showPdfList = courseKind === 'pdf' || courseKind === 'mixed';
  const pdfs = root?.pdfs ?? [];

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
    if (!rootId) return;
    void api<{ courses: SimilarCourse[] }>(
      `/api/similar-courses?rootId=${encodeURIComponent(rootId)}&limit=8`,
    )
      .then((r) => setSimilar(r.courses))
      .catch(() => setSimilar([]));
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

  useEffect(() => {
    if (pdfs.length === 0) {
      setPdfFocus(null);
      return;
    }
    if (pdfParam && pdfs.some((p) => p.id === pdfParam)) {
      setPdfFocus(pdfParam);
      return;
    }
    setPdfFocus((prev) => (prev && pdfs.some((p) => p.id === prev) ? prev : pdfs[0].id));
  }, [pdfs, pdfParam]);

  useEffect(() => {
    if (!pdfFocus || !showPdfList) {
      setPdfUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl = '';
    void apiBlob(`/api/documents/${encodeURIComponent(pdfFocus)}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setPdfUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pdfFocus, showPdfList]);

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

  async function downloadMaterials() {
    if (!root?.hasMaterialsZip) return;
    setMaterialsBusy(true);
    try {
      const blob = await apiBlob(`/api/course/${encodeURIComponent(root.id)}/materials.zip`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugifyDownload(root.name)}-code.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    } finally {
      setMaterialsBusy(false);
    }
  }

  const meta = root?.courseMeta;
  const durLabel = formatDuration(root?.durationSecondsTotal ?? undefined);
  const tagList = meta?.tags?.length ? meta.tags : [];
  const categoryList = (meta?.categories ?? []).filter((c) => c?.name?.trim());
  const hasDetailStrip =
    durLabel ||
    categoryList.length > 0 ||
    tagList.length > 0 ||
    root?.itemCount != null ||
    (root?.pdfCount ?? 0) > 0 ||
    meta?.addedAt;

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

      {hasDetailStrip ? (
        <div
          className="course-meta-strip"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1.25rem 2rem',
            padding: '1rem 0 1.25rem',
            borderBottom: '1px solid var(--border)',
            marginBottom: '1rem',
          }}
        >
          {durLabel ? (
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Duration
              </div>
              <div>{durLabel}</div>
            </div>
          ) : null}
          {categoryList.length > 0 ? (
            <div style={{ flex: '1 1 100%', minWidth: 'min(100%, 12rem)' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Categories
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.25rem' }}>
                {categoryList.map((c) => (
                  <span
                    key={c.name}
                    style={{
                      fontSize: '0.9rem',
                      padding: '0.15rem 0.45rem',
                      borderRadius: 6,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {tagList.length > 0 ? (
            <div style={{ flex: '1 1 100%', minWidth: 'min(100%, 12rem)' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Tags
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.25rem' }}>
                {tagList.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: '0.85rem',
                      padding: '0.15rem 0.45rem',
                      borderRadius: 6,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {root.itemCount > 0 ? (
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Lessons
              </div>
              <div>
                {root.itemCount} video{root.itemCount === 1 ? '' : 's'}
              </div>
            </div>
          ) : null}
          {(root.pdfCount ?? 0) > 0 ? (
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Documents
              </div>
              <div>
                {root.pdfCount} PDF{(root.pdfCount ?? 0) === 1 ? '' : 's'}
              </div>
            </div>
          ) : null}
          {meta?.addedAt ? (
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Added date
              </div>
              <div>{meta.addedAt}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {root.hasMaterialsZip ? (
        <p style={{ marginTop: 0 }}>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={materialsBusy}
            onClick={() => void downloadMaterials()}
          >
            {materialsBusy ? 'Preparing…' : 'Download course materials'}
          </button>
        </p>
      ) : null}

      {meta?.descriptionMarkdown ? (
        <div
          className="course-description markdown-body"
          style={{
            marginBottom: '1.25rem',
            padding: '1rem',
            background: 'var(--surface)',
            borderRadius: 10,
            border: '1px solid var(--border)',
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{meta.descriptionMarkdown}</ReactMarkdown>
        </div>
      ) : null}

      {courseKind === 'pdf' ? (
        <div className="pdf-course-layout" style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginTop: 0 }}>Documents</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
            {pdfs.map((p) => (
              <li key={p.id} style={{ marginBottom: '0.35rem' }}>
                <button
                  type="button"
                  className={`btn btn-ghost ${pdfFocus === p.id ? 'active' : ''}`}
                  style={pdfFocus === p.id ? { fontWeight: 700 } : {}}
                  onClick={() => setPdfFocus(p.id)}
                >
                  {p.title}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginLeft: '0.5rem' }}
                  onClick={() => void toggleBookmark(p.id)}
                >
                  {bookmarked.has(p.id) ? 'Unbookmark' : 'Bookmark'}
                </button>
              </li>
            ))}
          </ul>
          {pdfUrl ? (
            <iframe
              title="PDF"
              src={pdfUrl}
              style={{
                width: '100%',
                minHeight: 480,
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: '#222',
              }}
            />
          ) : (
            <p style={{ color: 'var(--muted)' }}>Select a document.</p>
          )}
        </div>
      ) : null}

      {showVideo ? (
        <div className="course-layout">
          <div>
            {flatItems.length > 0 ? (
              <>
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
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => toggleBookmark(current.id)}
                    >
                      {bookmarked.has(current.id) ? 'Remove bookmark' : 'Bookmark'}
                    </button>
                  </div>
                ) : (
                  <p style={{ color: 'var(--muted)' }}>No videos in this course.</p>
                )}
              </>
            ) : (
              <p style={{ color: 'var(--muted)' }}>No videos in this course.</p>
            )}
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
      ) : null}

      {courseKind === 'mixed' && showPdfList ? (
        <section style={{ marginTop: '1.5rem' }}>
          <h3>Documents</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {pdfs.map((p) => (
              <li key={p.id} style={{ marginBottom: '0.35rem' }}>
                <button
                  type="button"
                  className={`btn btn-ghost ${pdfFocus === p.id ? 'active' : ''}`}
                  style={pdfFocus === p.id ? { fontWeight: 700 } : {}}
                  onClick={() => setPdfFocus(p.id)}
                >
                  {p.title}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginLeft: '0.5rem' }}
                  onClick={() => void toggleBookmark(p.id)}
                >
                  {bookmarked.has(p.id) ? 'Unbookmark' : 'Bookmark'}
                </button>
              </li>
            ))}
          </ul>
          {pdfUrl ? (
            <iframe
              title="PDF"
              src={pdfUrl}
              style={{
                width: '100%',
                minHeight: 420,
                marginTop: '0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: '#222',
              }}
            />
          ) : null}
        </section>
      ) : null}

      {similar.length > 0 ? (
        <section style={{ marginTop: '2rem' }}>
          <h3 style={{ fontSize: '1.1rem' }}>Similar courses</h3>
          <div className="card-grid" style={{ marginTop: '0.75rem' }}>
            {similar.map((c) => (
              <Link key={c.id} className="tile" to={`/course/${encodeURIComponent(c.id)}`}>
                <strong>{c.name}</strong>
                <div className="count">
                  {c.itemCount > 0 ? `${c.itemCount} video${c.itemCount === 1 ? '' : 's'}` : ''}
                  {c.itemCount > 0 && (c.pdfCount ?? 0) > 0 ? ' · ' : ''}
                  {(c.pdfCount ?? 0) > 0
                    ? `${c.pdfCount} PDF${(c.pdfCount ?? 0) === 1 ? '' : 's'}`
                    : ''}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
