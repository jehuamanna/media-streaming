import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Root = { id: string; name: string; itemCount: number };

export default function Home() {
  const [roots, setRoots] = useState<Root[]>([]);
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

  return (
    <div className="app-shell">
      <h1>Courses</h1>
      {error ? <div className="error">{error}</div> : null}
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
