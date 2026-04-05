import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Bm = {
  fileId: string;
  title: string;
  rootId: string | null;
  playlistId: string | null;
  hlsUrl: string | null;
};

export default function Bookmarks() {
  const [items, setItems] = useState<Bm[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ bookmarks: Bm[] }>('/api/bookmarks');
        setItems(r.bookmarks);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed');
      }
    })();
  }, []);

  return (
    <div className="app-shell">
      <h1>Bookmarks</h1>
      {error ? <div className="error">{error}</div> : null}
      <ul className="bookmark-list">
        {items.map((b) => (
          <li key={b.fileId}>
            <strong>{b.title}</strong>
            {b.rootId ? (
              <>
                {' '}
                —{' '}
                <Link to={`/course/${encodeURIComponent(b.rootId)}`}>Open course</Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {items.length === 0 && !error ? (
        <p style={{ color: 'var(--muted)' }}>No bookmarks yet.</p>
      ) : null}
    </div>
  );
}
