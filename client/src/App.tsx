import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Home from './pages/Home';
import Course from './pages/Course';
import Bookmarks from './pages/Bookmarks';
import Live from './pages/Live';
import AdminUsers from './pages/AdminUsers';

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
      <span className="spacer" />
      <span style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{user.username}</span>
      <button type="button" className="btn btn-ghost" onClick={logout}>
        Log out
      </button>
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
      <Route path="/change-password" element={<ChangePassword />} />
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
