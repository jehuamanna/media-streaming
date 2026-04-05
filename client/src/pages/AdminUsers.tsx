import { useEffect, useState } from 'react';
import { api } from '../api';

type Row = {
  id: number;
  username: string;
  role: string;
  must_change_password: number;
  created_at: string;
};

export default function AdminUsers() {
  const [users, setUsers] = useState<Row[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState('');

  async function load() {
    const r = await api<{ users: Row[] }>('/api/admin/users');
    setUsers(r.users);
  }

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'Failed'));
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/admin/users', { method: 'POST', json: { username, password, role } });
      setUsername('');
      setPassword('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this user?')) return;
    setError('');
    try {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <div className="app-shell">
      <h1>Users</h1>
      {error ? <div className="error">{error}</div> : null}
      <form className="form-panel" onSubmit={onCreate} style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Add user</h2>
        <label htmlFor="nu">Username</label>
        <input id="nu" value={username} onChange={(e) => setUsername(e.target.value)} />
        <label htmlFor="np">Password (min 8)</label>
        <input id="np" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor="nr">Role</label>
        <select
          id="nr"
          value={role}
          onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
          style={{ width: '100%', marginBottom: '1rem', padding: '0.5rem' }}
        >
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" className="btn btn-primary">
          Create
        </button>
      </form>
      <table className="admin-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Username</th>
            <th>Role</th>
            <th>Must change pwd</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.username}</td>
              <td>{u.role}</td>
              <td>{u.must_change_password ? 'yes' : 'no'}</td>
              <td>
                <button type="button" className="btn btn-ghost" onClick={() => remove(u.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
