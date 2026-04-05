import { useEffect, useState } from 'react';
import { api } from '../api';

type Row = {
  id: number;
  username: string;
  role: string;
  must_change_password: number;
  created_at: string;
};

type TranscodeStatus = {
  running: boolean;
  total?: number;
  done?: number;
  currentFileId?: string | null;
};

export default function AdminUsers() {
  const [users, setUsers] = useState<Row[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState('');
  const [transcode, setTranscode] = useState<TranscodeStatus>({ running: false });
  const [transcodeMsg, setTranscodeMsg] = useState('');

  async function load() {
    const r = await api<{ users: Row[] }>('/api/admin/users');
    setUsers(r.users);
  }

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'Failed'));
  }, []);

  useEffect(() => {
    void api<TranscodeStatus>('/api/admin/transcode-all/status')
      .then((s) => {
        if (s.running) setTranscode(s);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!transcode.running) return;
    const t = window.setInterval(() => {
      void api<TranscodeStatus>('/api/admin/transcode-all/status')
        .then((s) => setTranscode(s))
        .catch(() => setTranscode({ running: false }));
    }, 2000);
    return () => clearInterval(t);
  }, [transcode.running]);

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

  async function startTranscodeAll() {
    setTranscodeMsg('');
    setError('');
    try {
      const r = await api<{ ok: boolean; queued: number; message: string }>(
        '/api/admin/transcode-all',
        { method: 'POST' },
      );
      setTranscodeMsg(`${r.queued} file(s) queued. ${r.message}`);
      setTranscode({ running: true, total: r.queued, done: 0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      if (msg === 'transcode_all_running') {
        setTranscodeMsg('A transcode job is already running.');
        setTranscode({ running: true });
        void api<TranscodeStatus>('/api/admin/transcode-all/status').then(setTranscode);
      } else {
        setError(msg);
      }
    }
  }

  return (
    <div className="app-shell">
      <h1>Users</h1>
      {error ? <div className="error">{error}</div> : null}
      <section className="form-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Video library (HLS cache)</h2>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          Transcode every file under <code>VIDEOS_DIR</code> into the on-disk HLS cache. Files that are already cached
          are skipped quickly. This runs on the server in the background and can take a long time and heavy CPU.
        </p>
        {transcode.running ? (
          <p>
            Transcoding: <strong>{transcode.done ?? 0}</strong> / <strong>{transcode.total ?? '…'}</strong>
            {transcode.currentFileId ? (
              <>
                {' '}
                <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>({transcode.currentFileId})</span>
              </>
            ) : null}
          </p>
        ) : null}
        {transcodeMsg ? <p style={{ color: 'var(--muted)' }}>{transcodeMsg}</p> : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={transcode.running}
          onClick={() => {
            if (!confirm('Start transcoding all videos in the library?')) return;
            void startTranscodeAll();
          }}
        >
          {transcode.running ? 'Transcoding…' : 'Transcode all videos'}
        </button>
      </section>
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
