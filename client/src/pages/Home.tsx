import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

type Root = {
  id: string;
  name: string;
  itemCount: number;
  pdfCount?: number;
  courseKind?: string;
  courseMeta?: {
    tags?: string[];
    categories?: { name: string; url?: string | null }[];
  } | null;
};

type ProgressRow = {
  fileId: string;
  title?: string;
  rootId?: string | null;
  positionSeconds: number;
  durationSeconds?: number | null;
  updatedAt?: string;
};

export default function Home() {
  const { user } = useAuth();
  const [roots, setRoots] = useState<Root[]>([]);
  const [continueRows, setContinueRows] = useState<ProgressRow[]>([]);
  const [error, setError] = useState('');
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ roots: Root[] }>('/api/library');
        setRoots(r.roots);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load library');
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ progress: ProgressRow[] }>('/api/progress?limit=12');
        const rows = r.progress.filter((p) => {
          if (!p.rootId) return false;
          const dur = p.durationSeconds;
          if (typeof dur === 'number' && Number.isFinite(dur) && dur > 5) {
            return p.positionSeconds < dur - 5;
          }
          return p.positionSeconds > 2;
        });
        setContinueRows(rows.slice(0, 8));
      } catch {
        setContinueRows([]);
      }
    })();
  }, []);

  return (
    <div className="app-shell">
      <h1>Courses</h1>
      {error ? <div className="error">{error}</div> : null}
      {continueRows.length > 0 ? (
        <section style={{ marginBottom: '1.75rem' }}>
          <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.75rem' }}>Continue watching</h2>
          <ul className="continue-list">
            {continueRows.map((p) => (
              <li key={p.fileId}>
                <Link
                  to={`/course/${encodeURIComponent(String(p.rootId))}?play=${encodeURIComponent(p.fileId)}`}
                >
                  {p.title || p.fileId}
                </Link>
                {p.rootId ? (
                  <span className="continue-meta">
                    {' '}
                    · {p.rootId}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="card-grid">
        {roots.map((r) => {
          const categories = (r.courseMeta?.categories ?? []).filter((c) => c?.name?.trim());
          const tags = r.courseMeta?.tags?.filter(Boolean) ?? [];
          return (
          <Link key={r.id} className="tile" to={`/course/${encodeURIComponent(r.id)}`}>
            <strong>{r.name}</strong>
            {categories.length > 0 ? (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.25rem',
                  marginTop: '0.4rem',
                }}
              >
                {categories.map((c) => (
                  <span
                    key={c.name}
                    style={{
                      fontSize: '0.72rem',
                      padding: '0.08rem 0.35rem',
                      borderRadius: 4,
                      background: 'color-mix(in srgb, var(--accent) 18%, var(--surface))',
                      color: 'var(--foreground)',
                    }}
                  >
                    {c.name}
                  </span>
                ))}
              </div>
            ) : null}
            {tags.length > 0 ? (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.25rem',
                  marginTop: categories.length > 0 ? '0.25rem' : '0.4rem',
                }}
              >
                {tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: '0.72rem',
                      padding: '0.08rem 0.35rem',
                      borderRadius: 4,
                      background: 'color-mix(in srgb, var(--border) 40%, transparent)',
                      color: 'var(--muted)',
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="count">
              {r.itemCount > 0 ? (
                <>
                  {r.itemCount} video{r.itemCount === 1 ? '' : 's'}
                </>
              ) : null}
              {r.itemCount > 0 && (r.pdfCount ?? 0) > 0 ? ' · ' : null}
              {(r.pdfCount ?? 0) > 0 ? (
                <>
                  {r.pdfCount} PDF{(r.pdfCount ?? 0) === 1 ? '' : 's'}
                </>
              ) : null}
              {r.itemCount === 0 && (r.pdfCount ?? 0) === 0 ? 'Course' : null}
            </div>
          </Link>
          );
        })}
      </div>
      {!error && roots.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>
          {isAdmin
            ? 'No folders found under /streaming/Videos/. Add a root folder with playlist subfolders.'
            : 'No courses are available at the moment.'}
        </p>
      ) : null}
    </div>
  );
}
