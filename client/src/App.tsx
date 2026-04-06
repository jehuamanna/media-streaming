import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Home from './pages/Home';
import Course from './pages/Course';
import Bookmarks from './pages/Bookmarks';
import Live from './pages/Live';
import AdminUsers from './pages/AdminUsers';

type SearchHit = {
  type: string;
  label: string;
  path: string;
  rootId: string;
  fileId: string | null;
  playlistId: string | null;
};

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const qt = q.trim();
    if (qt.length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => {
      void api<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(qt)}&limit=20`)
        .then((r) => {
          setResults(r.results);
          setOpen(r.results.length > 0);
        })
        .catch(() => {
          setResults([]);
          setOpen(false);
        });
    }, 280);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  function hrefFor(h: SearchHit): string {
    if (h.type === 'course') return `/course/${encodeURIComponent(h.rootId)}`;
    if (h.type === 'video' && h.fileId) {
      return `/course/${encodeURIComponent(h.rootId)}?play=${encodeURIComponent(h.fileId)}`;
    }
    if (h.type === 'pdf' && h.fileId) {
      return `/course/${encodeURIComponent(h.rootId)}?pdf=${encodeURIComponent(h.fileId)}`;
    }
    return `/course/${encodeURIComponent(h.rootId)}`;
  }

  return (
    <div className="nav-search-wrap">
      <input
        type="search"
        placeholder="Search…"
        aria-label="Search library"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (results.length) setOpen(true);
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 180);
        }}
      />
      {open && results.length > 0 ? (
        <div className="nav-search-results">
          {results.map((h, i) => (
            <Link
              key={`${h.path}-${i}`}
              to={hrefFor(h)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                setQ('');
              }}
            >
              <span>{h.label}</span>
              <span className="nav-search-meta">
                {h.type} · {h.path}
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChangePasswordRoute() {
  const { user, mustChangePassword, loading } = useAuth();
  if (loading) return <p className="app-shell">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <>
      {!mustChangePassword ? <NavBar /> : null}
      <ChangePassword />
    </>
  );
}

function NavBar() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <nav className="top-nav">
      <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')} end>
        Courses
      </NavLink>
      <NavLink to="/bookmarks" className={({ isActive }) => (isActive ? 'active' : '')}>
        Bookmarks
      </NavLink>
      <NavLink to="/live" className={({ isActive }) => (isActive ? 'active' : '')}>
        Live
      </NavLink>
      {user.role === 'admin' ? (
        <NavLink to="/admin/users" className={({ isActive }) => (isActive ? 'active' : '')}>
          Admin
        </NavLink>
      ) : null}
      <GlobalSearch />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginLeft: 'auto',
          flexShrink: 0,
        }}
      >
        <span style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{user.username}</span>
        <Link to="/change-password" className="btn btn-ghost" style={{ fontSize: '0.85rem' }}>
          Change password
        </Link>
        <button type="button" className="btn btn-ghost" onClick={logout}>
          Log out
        </button>
      </div>
    </nav>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, mustChangePassword, loading } = useAuth();
  if (loading) return <p className="app-shell">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  return (
    <>
      <NavBar />
      {children}
    </>
  );
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="app-shell">Loading…</p>;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<ChangePasswordRoute />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Home />
          </RequireAuth>
        }
      />
      <Route
        path="/course/:rootId"
        element={
          <RequireAuth>
            <Course />
          </RequireAuth>
        }
      />
      <Route
        path="/bookmarks"
        element={
          <RequireAuth>
            <Bookmarks />
          </RequireAuth>
        }
      />
      <Route
        path="/live"
        element={
          <RequireAuth>
            <Live />
          </RequireAuth>
        }
      />
      <Route
        path="/admin/users"
        element={
          <RequireAuth>
            <RequireAdmin>
              <AdminUsers />
            </RequireAdmin>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
