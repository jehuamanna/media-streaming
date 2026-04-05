import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Root = { id: string; name: string; itemCount: number };

type ProgressRow = {
  fileId: string;
  title?: string;
  rootId?: string | null;
  positionSeconds: number;
  durationSeconds?: number | null;
  updatedAt?: string;
};

export default function Home() {
  const [roots, setRoots] = useState<Root[]>([]);
  const [continueRows, setContinueRows] = useState<ProgressRow[]>([]);
  const [error, setError] = useState('');

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
        {roots.map((r) => (
          <Link key={r.id} className="tile" to={`/course/${encodeURIComponent(r.id)}`}>
            <strong>{r.name}</strong>
            <div className="count">{r.itemCount} video{r.itemCount === 1 ? '' : 's'}</div>
          </Link>
        ))}
      </div>
      {!error && roots.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No folders found under Videos/. Add a root folder with playlist subfolders.</p>
      ) : null}
    </div>
  );
}
