import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

export default function ChangePassword() {
  const { user, mustChangePassword, setSession, loading } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState('');

  if (loading) return <p className="app-shell">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const voluntary = !mustChangePassword;
      const r = await api<{ token: string; user: { id: number; username: string; role: string }; mustChangePassword: boolean }>(
        '/api/auth/change-password',
        { method: 'POST', json: { currentPassword, newPassword } },
      );
      setSession(r.token, r.user, !!r.mustChangePassword);
      if (voluntary) navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <div className="app-shell">
      <h1>Change password</h1>
      <p style={{ color: 'var(--muted)', maxWidth: 480 }}>
        {mustChangePassword
          ? 'You must set a new password before using the library.'
          : 'Enter your current password and a new password (at least 8 characters).'}
      </p>
      <form className="form-panel" onSubmit={onSubmit}>
        {error ? <div className="error">{error}</div> : null}
        <label htmlFor="c">Current password</label>
        <input
          id="c"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <label htmlFor="n">New password (min 8)</label>
        <input
          id="n"
          type="password"
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
          autoComplete="new-password"
        />
        <button type="submit" className="btn btn-primary">
          Update password
        </button>
      </form>
    </div>
  );
}
