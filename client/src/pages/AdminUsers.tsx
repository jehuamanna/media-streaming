import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

type Row = {
  id: number;
  username: string;
  role: string;
  must_change_password: number;
  created_at: string;
};

type VodEncodeProgress = {
  ratio: number | null;
  timeSec: number | null;
  durationSec: number | null;
};

type TranscodeStatus = {
  running: boolean;
  total?: number;
  done?: number;
  currentFileId?: string | null;
  startedAt?: number;
  currentProgress?: VodEncodeProgress | null;
};

function formatEncodeClock(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function vodTranscodeLibraryPercent(t: TranscodeStatus): number {
  if (!t.running || !t.total || t.total < 1) return 0;
  const done = t.done ?? 0;
  const cur = t.currentProgress?.ratio ?? 0;
  return Math.min(100, ((done + cur) / t.total) * 100);
}

function VodTranscodeProgressBar({ progress }: { progress: VodEncodeProgress | null | undefined }) {
  const ratio = progress?.ratio;
  const label =
    ratio != null
      ? `${Math.round(ratio * 100)}% · ${formatEncodeClock(progress?.timeSec ?? null)} / ${formatEncodeClock(progress?.durationSec ?? null)}`
      : 'Starting encoder…';
  return (
    <div style={{ marginTop: '0.35rem', width: '100%' }}>
      <progress
        style={{ width: '100%', height: '8px', accentColor: 'var(--accent, #3b82f6)' }}
        max={100}
        value={typeof ratio === 'number' ? Math.round(ratio * 100) : undefined}
      />
      <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.2rem' }}>{label}</div>
    </div>
  );
}

type VisItem = { id: string; title: string; hidden: boolean; globalHidden?: boolean };
type VisPlaylist = {
  id: string;
  name: string;
  hidden: boolean;
  globalHidden?: boolean;
  items: VisItem[];
};
type VisRoot = {
  id: string;
  name: string;
  hidden: boolean;
  globalHidden?: boolean;
  playlists: VisPlaylist[];
  pdfs: VisItem[];
};

type MainTab = 'users' | 'manage';
type ManageSub = 'transcode' | 'visibility' | 'details';

type VodItem = {
  id: string;
  title: string;
  ready: boolean;
  busy: boolean;
  progress?: VodEncodeProgress | null;
};
type VodPlaylist = { id: string; name: string; items: VodItem[] };
type VodRoot = { id: string; name: string; playlists: VodPlaylist[] };

function vodFlattenItems(root: VodRoot): VodItem[] {
  return root.playlists.flatMap((p) => p.items);
}

function vodRootStats(root: VodRoot) {
  const items = vodFlattenItems(root);
  if (items.length === 0) return { allReady: false, someReady: false, count: 0 };
  const n = items.length;
  const r = items.filter((i) => i.ready).length;
  return { allReady: r === n, someReady: r > 0, count: n };
}

function VodCourseCheckbox({
  allReady,
  someReady,
  disabled,
  title,
  onChange,
}: {
  allReady: boolean;
  someReady: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = someReady && !allReady;
  }, [someReady, allReady]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allReady}
      disabled={disabled}
      title={title}
      onChange={onChange}
      style={{ marginTop: '0.15rem', flexShrink: 0 }}
    />
  );
}

function useAdminSplitDrag(
  containerRef: RefObject<HTMLDivElement | null>,
  setFrac: Dispatch<SetStateAction<number>>,
) {
  return useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const onMove = (ev: MouseEvent) => {
        const row = containerRef.current;
        if (!row) return;
        const { left, width } = row.getBoundingClientRect();
        if (width <= 0) return;
        const frac = Math.max(0.15, Math.min(0.85, (ev.clientX - left) / width));
        setFrac(frac);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [containerRef, setFrac],
  );
}

export default function AdminUsers() {
  const [mainTab, setMainTab] = useState<MainTab>('users');
  const [manageSub, setManageSub] = useState<ManageSub>('transcode');
  const [users, setUsers] = useState<Row[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [usersError, setUsersError] = useState('');
  const { setSession } = useAuth();
  const [editUser, setEditUser] = useState<Row | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [vodError, setVodError] = useState('');
  const [visError, setVisError] = useState('');
  const [transcode, setTranscode] = useState<TranscodeStatus>({ running: false });
  const [transcodeMsg, setTranscodeMsg] = useState('');
  const [durationMsg, setDurationMsg] = useState('');
  const [visRoots, setVisRoots] = useState<VisRoot[] | null>(null);
  const [visLoading, setVisLoading] = useState(false);
  const [visSaving, setVisSaving] = useState(false);
  const [visForUserId, setVisForUserId] = useState('');
  const [selectedVisRootId, setSelectedVisRootId] = useState<string | null>(null);
  const [metaRootId, setMetaRootId] = useState('');
  const [metaCategories, setMetaCategories] = useState<{ name: string; url: string }[]>([]);
  const [metaAddedAt, setMetaAddedAt] = useState('');
  const [metaTags, setMetaTags] = useState<string[]>([]);
  const [metaTagDraft, setMetaTagDraft] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaMsg, setMetaMsg] = useState('');
  const [vodOverview, setVodOverview] = useState<VodRoot[] | null>(null);
  const [vodLoading, setVodLoading] = useState(false);
  const [vodSelectedRootId, setVodSelectedRootId] = useState<string | null>(null);
  const [vodMsg, setVodMsg] = useState('');
  /** Left column width as a fraction of the split row (default 60% / 40%). */
  const [vodLeftFrac, setVodLeftFrac] = useState(0.6);
  const vodSplitRef = useRef<HTMLDivElement>(null);
  const onVodSplitterMouseDown = useAdminSplitDrag(vodSplitRef, setVodLeftFrac);

  const [visLeftFrac, setVisLeftFrac] = useState(0.6);
  const visSplitRef = useRef<HTMLDivElement>(null);
  const onVisSplitterMouseDown = useAdminSplitDrag(visSplitRef, setVisLeftFrac);

  async function loadUsers() {
    const r = await api<{ users: Row[] }>('/api/admin/users');
    setUsers(r.users);
  }

  const loadVodOverview = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setVodLoading(true);
    setVodError('');
    try {
      const r = await api<{ roots: VodRoot[] }>('/api/admin/vod/overview');
      setVodOverview(r.roots);
    } catch (e) {
      setVodError(e instanceof Error ? e.message : 'Failed');
    } finally {
      if (!opts?.quiet) setVodLoading(false);
    }
  }, []);

  const loadVisibility = useCallback(async () => {
    setVisLoading(true);
    setVisError('');
    try {
      const qs = visForUserId ? `?forUser=${encodeURIComponent(visForUserId)}` : '';
      const r = await api<{ roots: VisRoot[] }>(`/api/admin/library-visibility${qs}`);
      setVisRoots(r.roots);
    } catch (e) {
      setVisError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setVisLoading(false);
    }
  }, [visForUserId]);

  useEffect(() => {
    void loadUsers().catch((e) => setUsersError(e instanceof Error ? e.message : 'Failed'));
  }, []);

  useEffect(() => {
    if (mainTab !== 'users') {
      setEditUser(null);
      setEditPassword('');
    }
  }, [mainTab]);

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
    }, 1000);
    return () => clearInterval(t);
  }, [transcode.running]);

  useEffect(() => {
    if (mainTab !== 'manage' || manageSub !== 'visibility') return;
    void loadVisibility();
  }, [mainTab, manageSub, loadVisibility]);

  useEffect(() => {
    if (mainTab !== 'manage' || manageSub !== 'transcode') return;
    void loadVodOverview();
  }, [mainTab, manageSub, loadVodOverview]);

  useEffect(() => {
    if (!vodOverview?.length) {
      setVodSelectedRootId(null);
      return;
    }
    setVodSelectedRootId((prev) =>
      prev && vodOverview.some((r) => r.id === prev) ? prev : vodOverview[0].id,
    );
  }, [vodOverview]);

  const vodAnyBusy = useMemo(
    () =>
      vodOverview?.some((root) => root.playlists.some((pl) => pl.items.some((it) => it.busy))) ??
      false,
    [vodOverview],
  );

  useEffect(() => {
    if (mainTab !== 'manage' || manageSub !== 'transcode') return;
    if (!vodAnyBusy && !transcode.running) return;
    const t = window.setInterval(() => void loadVodOverview({ quiet: true }), 1000);
    return () => clearInterval(t);
  }, [mainTab, manageSub, vodAnyBusy, transcode.running, loadVodOverview]);

  useEffect(() => {
    if (mainTab !== 'manage' || manageSub !== 'details') return;
    if (!visRoots && !visLoading) void loadVisibility();
  }, [mainTab, manageSub, visRoots, visLoading, loadVisibility]);

  useEffect(() => {
    if (visRoots?.length && !metaRootId) setMetaRootId(visRoots[0].id);
  }, [visRoots, metaRootId]);

  useEffect(() => {
    if (!visRoots?.length) {
      setSelectedVisRootId(null);
      return;
    }
    setSelectedVisRootId((prev) =>
      prev && visRoots.some((r) => r.id === prev) ? prev : null,
    );
  }, [visRoots]);

  useEffect(() => {
    if (mainTab !== 'manage' || manageSub !== 'details' || !metaRootId) return;
    setMetaLoading(true);
    setMetaMsg('');
    void api<{
      rootId: string;
      categories: { name: string; url: string | null }[];
      addedAt: string;
      descriptionMarkdown: string;
      tags: string[];
    }>(`/api/admin/course-metadata/${encodeURIComponent(metaRootId)}`)
      .then((m) => {
        const cats = Array.isArray(m.categories) ? m.categories : [];
        setMetaCategories(
          cats.length > 0
            ? cats.map((c) => ({ name: c.name || '', url: c.url || '' }))
            : [{ name: '', url: '' }],
        );
        setMetaAddedAt(m.addedAt || '');
        setMetaTags(Array.isArray(m.tags) ? m.tags : []);
        setMetaTagDraft('');
        setMetaDescription(m.descriptionMarkdown || '');
      })
      .catch((e) => setMetaMsg(e instanceof Error ? e.message : 'Failed'))
      .finally(() => setMetaLoading(false));
  }, [mainTab, manageSub, metaRootId]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setUsersError('');
    try {
      await api('/api/admin/users', { method: 'POST', json: { username, password, role } });
      setUsername('');
      setPassword('');
      await loadUsers();
    } catch (err) {
      setUsersError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this user?')) return;
    setUsersError('');
    try {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      await loadUsers();
    } catch (err) {
      setUsersError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function onSaveUserEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setUsersError('');
    const body: { username?: string; password?: string } = {};
    const nu = editUsername.trim();
    if (nu !== editUser.username) body.username = nu;
    const pw = editPassword.trim();
    if (pw) body.password = pw;
    if (body.username === undefined && body.password === undefined) {
      setUsersError('Change the username and/or enter a new password.');
      return;
    }
    setEditSaving(true);
    try {
      const r = await api<{ user: Row; token?: string }>(`/api/admin/users/${editUser.id}`, {
        method: 'PATCH',
        json: body,
      });
      if (r.token) {
        setSession(
          r.token,
          { id: r.user.id, username: r.user.username, role: r.user.role },
          !!r.user.must_change_password,
        );
      }
      setEditUser(null);
      setEditPassword('');
      await loadUsers();
    } catch (err) {
      setUsersError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setEditSaving(false);
    }
  }

  async function vodStartFile(fileId: string) {
    setVodMsg('');
    try {
      await api(`/api/admin/vod/transcode/${encodeURIComponent(fileId)}`, { method: 'POST' });
      await loadVodOverview({ quiet: true });
    } catch (e) {
      setVodMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function vodClearFile(fileId: string) {
    setVodMsg('');
    try {
      await api(`/api/admin/vod/cache/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
      await loadVodOverview({ quiet: true });
    } catch (e) {
      setVodMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function vodStartCourse(rootId: string, opts?: { force?: boolean }) {
    setVodMsg('');
    try {
      const r = await api<{ ok: boolean; queued: number }>(
        `/api/admin/vod/transcode-root/${encodeURIComponent(rootId)}`,
        { method: 'POST', json: { force: Boolean(opts?.force) } },
      );
      setVodMsg(
        opts?.force
          ? `Re-encoding ${r.queued} video(s) in this course (replaces existing HLS).`
          : `Queued ${r.queued} video(s) (only videos without ready HLS are encoded).`,
      );
      await loadVodOverview({ quiet: true });
    } catch (e) {
      setVodMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function vodClearCourse(rootId: string) {
    setVodMsg('');
    try {
      const r = await api<{ ok: boolean; cleared: number }>(
        `/api/admin/vod/cache-root/${encodeURIComponent(rootId)}`,
        { method: 'DELETE' },
      );
      setVodMsg(`Cleared cache for ${r.cleared} video(s).`);
      await loadVodOverview({ quiet: true });
    } catch (e) {
      setVodMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function startTranscodeAll() {
    setTranscodeMsg('');
    setVodError('');
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
        setVodError(msg);
      }
    }
  }

  async function refreshDurations() {
    setDurationMsg('');
    setVodError('');
    try {
      const r = await api<{ probed: number; errors: number; total: number }>(
        '/api/admin/media-duration/refresh',
        { method: 'POST', json: { cap: 200 } },
      );
      setDurationMsg(`Probed ${r.probed} of ${r.total} (${r.errors} errors).`);
    } catch (e) {
      setVodError(e instanceof Error ? e.message : 'Failed');
    }
  }

  function toggleRootHidden(id: string) {
    setVisRoots((prev) =>
      prev?.map((r) => (r.id === id ? { ...r, hidden: !r.hidden } : r)) ?? null,
    );
  }

  function togglePlHidden(rootId: string, plId: string) {
    setVisRoots((prev) =>
      prev?.map((r) =>
        r.id !== rootId
          ? r
          : {
              ...r,
              playlists: r.playlists.map((p) =>
                p.id === plId ? { ...p, hidden: !p.hidden } : p,
              ),
            },
      ) ?? null,
    );
  }

  function toggleItemHidden(rootId: string, plId: string, itemId: string) {
    setVisRoots((prev) =>
      prev?.map((r) =>
        r.id !== rootId
          ? r
          : {
              ...r,
              playlists: r.playlists.map((p) =>
                p.id !== plId
                  ? p
                  : {
                      ...p,
                      items: p.items.map((it) =>
                        it.id === itemId ? { ...it, hidden: !it.hidden } : it,
                      ),
                    },
              ),
            },
      ) ?? null,
    );
  }

  function togglePdfHidden(rootId: string, pdfId: string) {
    setVisRoots((prev) =>
      prev?.map((r) =>
        r.id !== rootId
          ? r
          : {
              ...r,
              pdfs: r.pdfs.map((p) => (p.id === pdfId ? { ...p, hidden: !p.hidden } : p)),
            },
      ) ?? null,
    );
  }

  async function saveVisibility() {
    if (!visRoots) return;
    setVisSaving(true);
    setVisError('');
    try {
      const hiddenCourses = visRoots.filter((r) => r.hidden).map((r) => r.id);
      const hiddenPlaylists: { rootId: string; playlistId: string }[] = [];
      const hiddenVideos: string[] = [];
      for (const r of visRoots) {
        for (const pl of r.playlists) {
          if (pl.hidden) hiddenPlaylists.push({ rootId: r.id, playlistId: pl.id });
          for (const it of pl.items) {
            if (it.hidden) hiddenVideos.push(it.id);
          }
        }
        for (const p of r.pdfs) {
          if (p.hidden) hiddenVideos.push(p.id);
        }
      }
      const forUser =
        visForUserId.trim() !== '' ? parseInt(visForUserId, 10) : NaN;
      await api('/api/admin/library-visibility', {
        method: 'PUT',
        json: {
          hiddenCourses,
          hiddenPlaylists,
          hiddenVideos,
          ...(Number.isFinite(forUser) && forUser > 0 ? { forUser } : {}),
        },
      });
      await loadVisibility();
    } catch (e) {
      setVisError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setVisSaving(false);
    }
  }

  function addMetaTag() {
    const s = metaTagDraft.trim();
    if (!s) return;
    setMetaTags((prev) => {
      if (prev.some((t) => t.toLowerCase() === s.toLowerCase())) return prev;
      if (prev.length >= 50) return prev;
      return [...prev, s];
    });
    setMetaTagDraft('');
  }

  function removeMetaTag(tag: string) {
    setMetaTags((prev) => prev.filter((t) => t !== tag));
  }

  function addMetaCategoryRow() {
    setMetaCategories((prev) => {
      if (prev.length >= 20) return prev;
      return [...prev, { name: '', url: '' }];
    });
  }

  function removeMetaCategoryRow(index: number) {
    setMetaCategories((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [{ name: '', url: '' }];
    });
  }

  function setMetaCategoryRow(index: number, field: 'name' | 'url', value: string) {
    setMetaCategories((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  async function saveMetadata() {
    if (!metaRootId) return;
    setMetaMsg('');
    try {
      const categoriesPayload = metaCategories
        .map((c) => ({
          name: c.name.trim(),
          url: c.url.trim() || null,
        }))
        .filter((c) => c.name);
      await api(`/api/admin/course-metadata/${encodeURIComponent(metaRootId)}`, {
        method: 'PUT',
        json: {
          categories: categoriesPayload,
          addedAt: metaAddedAt || null,
          descriptionMarkdown: metaDescription || null,
          tags: metaTags,
        },
      });
      setMetaMsg('Saved.');
    } catch (e) {
      setMetaMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <div className="app-shell">
      <h1>Admin</h1>
      {mainTab === 'users' && usersError ? <div className="error">{usersError}</div> : null}
      {mainTab === 'manage' && manageSub === 'transcode' && vodError ? (
        <div className="error">{vodError}</div>
      ) : null}
      {mainTab === 'manage' && manageSub === 'visibility' && visError ? (
        <div className="error">{visError}</div>
      ) : null}
      <div className="admin-tabs" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <button
          type="button"
          className={`btn ${mainTab === 'users' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMainTab('users')}
        >
          Users
        </button>
        <button
          type="button"
          className={`btn ${mainTab === 'manage' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMainTab('manage')}
        >
          Manage videos
        </button>
      </div>

      {mainTab === 'users' ? (
        <>
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
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>{u.username}</td>
                  <td>{u.role}</td>
                  <td>{u.must_change_password ? 'yes' : 'no'}</td>
                  <td style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditUser(u);
                        setEditUsername(u.username);
                        setEditPassword('');
                        setUsersError('');
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => remove(u.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {editUser ? (
            <form className="form-panel" onSubmit={onSaveUserEdit} style={{ marginTop: '1.25rem', maxWidth: 420 }}>
              <h2 style={{ marginTop: 0 }}>Edit user</h2>
              <p style={{ color: 'var(--muted)', marginTop: 0 }}>
                User ID {editUser.id} · {editUser.role}. Setting a new password clears “must change password” so the user
                can use the library and change their password from the account menu when they want.
              </p>
              <label htmlFor="eu-name">Username</label>
              <input
                id="eu-name"
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
                autoComplete="off"
              />
              <label htmlFor="eu-pw">New password (optional, min 8)</label>
              <input
                id="eu-pw"
                type="password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="Leave blank to keep current"
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="submit" className="btn btn-primary" disabled={editSaving}>
                  {editSaving ? 'Saving…' : 'Save changes'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={editSaving}
                  onClick={() => {
                    setEditUser(null);
                    setEditPassword('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : (
        <>
          <div className="admin-subtabs" style={{ display: 'flex', gap: '0.35rem', marginBottom: '1rem' }}>
            {(['transcode', 'visibility', 'details'] as ManageSub[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`btn btn-ghost ${manageSub === s ? 'active' : ''}`}
                style={manageSub === s ? { fontWeight: 700 } : {}}
                onClick={() => setManageSub(s)}
              >
                {s === 'transcode'
                  ? 'Transcode'
                  : s === 'visibility'
                    ? 'Visibility'
                    : 'Course details'}
              </button>
            ))}
          </div>

          {manageSub === 'transcode' ? (
            <section className="form-panel form-panel-wide">
              <h2 style={{ marginTop: 0 }}>Video library (HLS cache)</h2>
              <p style={{ color: 'var(--muted)', marginTop: 0 }}>
                Select a course on the left. Each checkbox reflects <strong>current</strong> state: checked only when
                HLS is already ready. To <strong>start</strong> transcoding, click an <strong>unchecked</strong> box to
                check it. If a box is already checked, a click tries to <strong>uncheck</strong> (clear cache)—it does
                not start a new encode. To rebuild something that already shows checked, use <strong>Re-encode</strong>{' '}
                or uncheck (clear) and then check again. The course checkbox only encodes videos that are still
                unchecked; use <strong>Re-encode course</strong> to replace HLS for every video in that course. PDFs are
                not listed.
              </p>
              {vodLoading && !vodOverview ? <p>Loading…</p> : null}
              <div className="admin-vod-split-head">
                <div className="admin-vod-split-pane-left admin-vod-split-head-label" style={{ width: `${vodLeftFrac * 100}%` }}>
                  Courses
                </div>
                <div className="admin-vod-split-head-spacer" aria-hidden />
                <div className="admin-vod-split-pane-right admin-vod-split-head-label" style={{ flex: 1, minWidth: 0 }}>
                  Videos
                </div>
              </div>
              <div ref={vodSplitRef} className="admin-vod-split">
                <div
                  className="admin-vod-split-pane-left"
                  style={{
                    width: `${vodLeftFrac * 100}%`,
                    flexShrink: 0,
                    border: '1px solid var(--border)',
                    borderRadius: 14,
                    padding: '0.65rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.45rem',
                    maxHeight: '70vh',
                    overflowY: 'auto',
                    minWidth: 0,
                  }}
                >
                  {vodOverview?.map((root) => {
                    const stats = vodRootStats(root);
                    return (
                      <div
                        key={root.id}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.55rem',
                          padding: '0.65rem 0.7rem',
                          borderRadius: 12,
                          border: '1px solid var(--border)',
                          background:
                            vodSelectedRootId === root.id
                              ? 'color-mix(in srgb, var(--border) 35%, transparent)'
                              : 'var(--surface)',
                        }}
                      >
                        <VodCourseCheckbox
                          allReady={stats.allReady}
                          someReady={stats.someReady}
                          disabled={stats.count === 0}
                          title={
                            stats.count === 0
                              ? undefined
                              : stats.allReady
                                ? 'All videos have HLS. Click to clear cache, or use Re-encode course to replace HLS.'
                                : 'Check to encode videos that are not ready yet. Indeterminate = some ready.'
                          }
                          onChange={(e) => {
                            if (stats.count === 0) return;
                            const wantOn = e.target.checked;
                            if (wantOn) {
                              void vodStartCourse(root.id);
                            } else if (
                              stats.someReady &&
                              confirm(`Clear HLS cache for all videos in “${root.name}”?`)
                            ) {
                              void vodClearCourse(root.id);
                            } else {
                              e.target.checked = stats.allReady;
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setVodSelectedRootId(root.id)}
                          style={{
                            flex: 1,
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            color: 'inherit',
                            cursor: 'pointer',
                            fontWeight: vodSelectedRootId === root.id ? 700 : 500,
                            padding: 0,
                            fontSize: '0.95rem',
                            lineHeight: 1.35,
                          }}
                        >
                          {root.name}
                        </button>
                        {stats.count > 0 ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ fontSize: '0.75rem', padding: '0.25rem 0.45rem', flexShrink: 0 }}
                            title="Replace HLS for every video in this course"
                            onClick={() => {
                              if (
                                confirm(
                                  `Re-encode all videos in “${root.name}”? This replaces existing HLS cache.`,
                                )
                              ) {
                                void vodStartCourse(root.id, { force: true });
                              }
                            }}
                          >
                            Re-encode course
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize course and video columns"
                  tabIndex={0}
                  className="admin-vod-splitter"
                  onMouseDown={onVodSplitterMouseDown}
                  onKeyDown={(ke) => {
                    const step = ke.shiftKey ? 0.05 : 0.02;
                    if (ke.key === 'ArrowLeft') {
                      ke.preventDefault();
                      setVodLeftFrac((f) => Math.max(0.15, f - step));
                    } else if (ke.key === 'ArrowRight') {
                      ke.preventDefault();
                      setVodLeftFrac((f) => Math.min(0.85, f + step));
                    }
                  }}
                />
                <div
                  className="admin-vod-split-pane-right"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: '12rem',
                    border: '1px solid var(--border)',
                    borderRadius: 14,
                    padding: '0.75rem',
                    overflowY: 'auto',
                    maxHeight: '70vh',
                  }}
                >
                  {(() => {
                    const r = vodOverview?.find((x) => x.id === vodSelectedRootId);
                    if (!r) {
                      return (
                        <p style={{ color: 'var(--muted)', margin: 0 }}>
                          {vodOverview?.length ? 'Select a course.' : 'No courses found.'}
                        </p>
                      );
                    }
                    return (
                      <>
                        <div style={{ fontWeight: 700, marginBottom: '0.65rem' }}>{r.name}</div>
                        {r.playlists.map((pl) => (
                          <div key={pl.id} style={{ marginBottom: '0.85rem' }}>
                            <div
                              style={{
                                fontSize: '0.8rem',
                                fontWeight: 600,
                                color: 'var(--muted)',
                                marginBottom: '0.35rem',
                                textTransform: 'uppercase',
                                letterSpacing: '0.03em',
                              }}
                            >
                              {pl.name}
                            </div>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                              {pl.items.map((it) => (
                                <li key={it.id} style={{ marginBottom: '0.35rem' }}>
                                  <div
                                    style={{
                                      padding: '0.45rem 0.65rem',
                                      borderRadius: 10,
                                      border: '1px solid var(--border)',
                                      background: 'var(--surface)',
                                      opacity: it.busy ? 0.72 : 1,
                                    }}
                                  >
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.6rem',
                                      }}
                                    >
                                      <label
                                        htmlFor={`vod-ready-${it.id}`}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '0.6rem',
                                          flex: 1,
                                          minWidth: 0,
                                          cursor: it.busy ? 'default' : 'pointer',
                                          margin: 0,
                                        }}
                                      >
                                        <input
                                          id={`vod-ready-${it.id}`}
                                          type="checkbox"
                                          checked={it.ready}
                                          disabled={it.busy}
                                          title={
                                            it.busy
                                              ? 'Transcoding…'
                                              : it.ready
                                                ? 'HLS ready. Click clears cache; use Re-encode to replace.'
                                                : 'Check to start transcoding'
                                          }
                                          onChange={(e) => {
                                            if (it.busy) {
                                              e.target.checked = it.ready;
                                              return;
                                            }
                                            const wantOn = e.target.checked;
                                            if (wantOn && !it.ready) {
                                              void vodStartFile(it.id);
                                            } else if (!wantOn && it.ready) {
                                              if (confirm(`Clear HLS cache for “${it.title}”?`)) void vodClearFile(it.id);
                                              else e.target.checked = it.ready;
                                            } else {
                                              e.target.checked = it.ready;
                                            }
                                          }}
                                        />
                                        <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{it.title}</span>
                                      </label>
                                      {it.ready && !it.busy ? (
                                        <button
                                          type="button"
                                          className="btn btn-ghost"
                                          style={{ fontSize: '0.75rem', padding: '0.2rem 0.45rem', flexShrink: 0 }}
                                          title="Replace HLS for this file"
                                          onClick={() => {
                                            if (confirm(`Re-encode “${it.title}”? This replaces the current HLS cache.`)) {
                                              void vodStartFile(it.id);
                                            }
                                          }}
                                        >
                                          Re-encode
                                        </button>
                                      ) : null}
                                    </div>
                                    {it.busy ? <VodTranscodeProgressBar progress={it.progress} /> : null}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </>
                    );
                  })()}
                </div>
              </div>
              {vodMsg ? <p style={{ color: 'var(--muted)', marginTop: 0 }}>{vodMsg}</p> : null}
              <h3 style={{ margin: '1.25rem 0 0.5rem', fontSize: '1.05rem' }}>Whole library</h3>
              <p style={{ color: 'var(--muted)', marginTop: 0 }}>
                Batch transcode every video under <code>VIDEOS_DIR</code>. Already-cached files are skipped quickly.
              </p>
              {transcode.running ? (
                <div style={{ maxWidth: '36rem' }}>
                  <p style={{ marginBottom: '0.5rem' }}>
                    Library transcode: <strong>{transcode.done ?? 0}</strong> /{' '}
                    <strong>{transcode.total ?? '…'}</strong> files done
                    {transcode.currentFileId ? (
                      <span style={{ color: 'var(--muted)', fontSize: '0.85rem', display: 'block', marginTop: '0.25rem' }}>
                        Current: <code style={{ fontSize: '0.8rem' }}>{transcode.currentFileId}</code>
                      </span>
                    ) : null}
                  </p>
                  <progress
                    style={{ width: '100%', height: '10px', accentColor: 'var(--accent, #3b82f6)' }}
                    max={100}
                    value={Math.round(vodTranscodeLibraryPercent(transcode))}
                  />
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.35rem' }}>
                    Overall ~{Math.round(vodTranscodeLibraryPercent(transcode))}% (includes in-progress file)
                  </div>
                  {transcode.currentProgress ? (
                    <div style={{ marginTop: '0.75rem' }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                        Current file
                      </div>
                      <VodTranscodeProgressBar progress={transcode.currentProgress} />
                    </div>
                  ) : transcode.currentFileId ? (
                    <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem', marginBottom: 0 }}>
                      Waiting for encoder output…
                    </p>
                  ) : null}
                </div>
              ) : null}
              {transcodeMsg ? <p style={{ color: 'var(--muted)' }}>{transcodeMsg}</p> : null}
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
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
                <button type="button" className="btn btn-ghost" onClick={() => void refreshDurations()}>
                  Refresh video durations (ffprobe)
                </button>
              </div>
              {durationMsg ? <p style={{ color: 'var(--muted)', marginTop: '0.75rem' }}>{durationMsg}</p> : null}
            </section>
          ) : null}

          {manageSub === 'visibility' ? (
            <section className="form-panel form-panel-wide">
              <h2 style={{ marginTop: 0 }}>Show / hide in library</h2>
              <label htmlFor="vis-user">Visibility applies to</label>
              <select
                id="vis-user"
                value={visForUserId}
                onChange={(e) => setVisForUserId(e.target.value)}
                style={{ width: '100%', maxWidth: '24rem', marginBottom: '0.75rem', padding: '0.5rem' }}
              >
                <option value="">All users (default)</option>
                {users.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.username}
                  </option>
                ))}
              </select>
              {visForUserId ? (
                <p style={{ color: 'var(--muted)', marginTop: 0 }}>
                  Per-user hides add on top of global visibility. Checkboxes locked by global rules cannot be shown for
                  this user alone.
                </p>
              ) : null}
              <p style={{ color: 'var(--muted)', marginTop: visForUserId ? '0.5rem' : 0, marginBottom: 0 }}>
                Select a course on the left to load its videos and PDFs on the right. The course checkbox shows or hides
                the whole course in the library
                {visForUserId ? ' for this user' : ' for all learners'} (click the row to select; the checkbox only
                toggles visibility). On the right, use playlist rows to hide an entire playlist, or individual rows for
                each video or PDF. If the course is hidden, learners see nothing from it until you show it again.
              </p>
              {visLoading ? <p>Loading…</p> : null}
              <div className="admin-vod-split-head">
                <div
                  className="admin-vod-split-pane-left admin-vod-split-head-label"
                  style={{ width: `${visLeftFrac * 100}%` }}
                >
                  Courses
                </div>
                <div className="admin-vod-split-head-spacer" aria-hidden />
                <div
                  className="admin-vod-split-pane-right admin-vod-split-head-label"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  Videos & files
                </div>
              </div>
              <div ref={visSplitRef} className="admin-vod-split">
                <div
                  className="admin-vod-split-pane-left"
                  style={{
                    width: `${visLeftFrac * 100}%`,
                    flexShrink: 0,
                    border: '1px solid var(--border)',
                    borderRadius: 14,
                    padding: '0.65rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.45rem',
                    maxHeight: '70vh',
                    overflowY: 'auto',
                    minWidth: 0,
                  }}
                >
                  {visRoots?.map((r) => {
                    const selected = selectedVisRootId === r.id;
                    return (
                      <div
                        key={r.id}
                        role="button"
                        tabIndex={0}
                        title="Show this course’s videos and files on the right"
                        aria-current={selected ? 'true' : undefined}
                        aria-label={`Course ${r.name}`}
                        onClick={() => setSelectedVisRootId(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedVisRootId(r.id);
                          }
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.55rem',
                          padding: '0.65rem 0.7rem',
                          borderRadius: 12,
                          border: '1px solid var(--border)',
                          background: selected
                            ? 'color-mix(in srgb, var(--border) 35%, transparent)'
                            : 'var(--surface)',
                          cursor: 'pointer',
                          outline: 'none',
                          opacity: r.hidden ? 0.72 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!r.hidden}
                          disabled={!!r.globalHidden}
                          title={
                            r.globalHidden
                              ? 'Hidden for all users (change under All users)'
                              : 'Show or hide the entire course in the library'
                          }
                          aria-label={`Show entire course in library: ${r.name}`}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => {
                            if (r.globalHidden) return;
                            toggleRootHidden(r.id);
                          }}
                          style={{ marginTop: '0.15rem', flexShrink: 0 }}
                        />
                        <span
                          style={{
                            flex: 1,
                            textAlign: 'left',
                            fontWeight: selected ? 700 : 500,
                            fontSize: '0.95rem',
                            lineHeight: 1.35,
                            color: r.hidden ? 'var(--muted)' : 'inherit',
                          }}
                        >
                          {r.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize course and file list columns"
                  tabIndex={0}
                  className="admin-vod-splitter"
                  onMouseDown={onVisSplitterMouseDown}
                  onKeyDown={(ke) => {
                    const step = ke.shiftKey ? 0.05 : 0.02;
                    if (ke.key === 'ArrowLeft') {
                      ke.preventDefault();
                      setVisLeftFrac((f) => Math.max(0.15, f - step));
                    } else if (ke.key === 'ArrowRight') {
                      ke.preventDefault();
                      setVisLeftFrac((f) => Math.min(0.85, f + step));
                    }
                  }}
                />
                <div
                  className="admin-vod-split-pane-right"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: '12rem',
                    border: '1px solid var(--border)',
                    borderRadius: 14,
                    padding: '0.75rem',
                    overflowY: 'auto',
                    maxHeight: '70vh',
                  }}
                >
                  {(() => {
                    const r = visRoots?.find((x) => x.id === selectedVisRootId);
                    if (!r) {
                      return (
                        <p style={{ color: 'var(--muted)', margin: 0 }}>
                          {visRoots?.length ? 'Select a course to list its videos.' : 'No courses found.'}
                        </p>
                      );
                    }
                    return (
                      <>
                        <div style={{ fontWeight: 700, marginBottom: '0.65rem' }}>{r.name}</div>
                        {r.hidden ? (
                          <p
                            style={{
                              color: 'var(--muted)',
                              margin: '0 0 0.75rem',
                              padding: '0.5rem 0.65rem',
                              borderRadius: 10,
                              border: '1px solid var(--border)',
                              background: 'color-mix(in srgb, var(--border) 22%, transparent)',
                            }}
                          >
                            This course is hidden for learners, so nothing in it appears in the library. Show the
                            course on the left to make playlist and file choices take effect.
                          </p>
                        ) : null}
                        {r.playlists.map((pl) => (
                          <div key={pl.id} style={{ marginBottom: '0.85rem' }}>
                            <label
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem',
                                padding: '0.45rem 0.65rem',
                                marginBottom: '0.35rem',
                                borderRadius: 10,
                                border: '1px solid var(--border)',
                                background: 'var(--surface)',
                                cursor: pl.globalHidden ? 'default' : 'pointer',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={!pl.hidden}
                                disabled={!!pl.globalHidden}
                                title={
                                  pl.globalHidden ? 'Hidden for all users (change under All users)' : undefined
                                }
                                onChange={() => {
                                  if (pl.globalHidden) return;
                                  togglePlHidden(r.id, pl.id);
                                }}
                              />
                              <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>Playlist: {pl.name}</span>
                            </label>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                              {pl.items.map((it) => (
                                <li key={it.id} style={{ marginBottom: '0.35rem' }}>
                                  <label
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '0.6rem',
                                      padding: '0.45rem 0.65rem',
                                      borderRadius: 10,
                                      border: '1px solid var(--border)',
                                      background: 'var(--surface)',
                                      cursor: it.globalHidden ? 'default' : 'pointer',
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={!it.hidden}
                                      disabled={!!it.globalHidden}
                                      title={
                                        it.globalHidden
                                          ? 'Hidden for all users (change under All users)'
                                          : undefined
                                      }
                                      onChange={() => {
                                        if (it.globalHidden) return;
                                        toggleItemHidden(r.id, pl.id, it.id);
                                      }}
                                    />
                                    <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{it.title}</span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                        {r.pdfs.length > 0 ? (
                          <div style={{ marginTop: '0.25rem' }}>
                            <div
                              style={{
                                fontSize: '0.8rem',
                                fontWeight: 600,
                                color: 'var(--muted)',
                                marginBottom: '0.35rem',
                                textTransform: 'uppercase',
                                letterSpacing: '0.03em',
                              }}
                            >
                              PDFs
                            </div>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                              {r.pdfs.map((p) => (
                                <li key={p.id} style={{ marginBottom: '0.35rem' }}>
                                  <label
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '0.6rem',
                                      padding: '0.45rem 0.65rem',
                                      borderRadius: 10,
                                      border: '1px solid var(--border)',
                                      background: 'var(--surface)',
                                      cursor: p.globalHidden ? 'default' : 'pointer',
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={!p.hidden}
                                      disabled={!!p.globalHidden}
                                      title={
                                        p.globalHidden
                                          ? 'Hidden for all users (change under All users)'
                                          : undefined
                                      }
                                      onChange={() => {
                                        if (p.globalHidden) return;
                                        togglePdfHidden(r.id, p.id);
                                      }}
                                    />
                                    <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{p.title}</span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={visSaving || !visRoots}
                onClick={() => void saveVisibility()}
              >
                {visSaving ? 'Saving…' : 'Save visibility'}
              </button>
            </section>
          ) : null}

          {manageSub === 'details' ? (
            <section className="form-panel form-panel-wide">
              <h2 style={{ marginTop: 0 }}>Course metadata</h2>
              <label htmlFor="cr">Course folder</label>
              <select
                id="cr"
                value={metaRootId}
                onChange={(e) => setMetaRootId(e.target.value)}
                style={{ width: '100%', marginBottom: '1rem', padding: '0.5rem' }}
              >
                {visRoots?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              {!visRoots?.length ? (
                <button type="button" className="btn btn-ghost" onClick={() => void loadVisibility()}>
                  Load courses
                </button>
              ) : null}
              {metaLoading ? <p>Loading…</p> : null}
              <div style={{ marginBottom: '0.5rem' }}>
                <span id="cats-label">Categories</span>
                <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0.25rem 0 0.5rem' }}>
                  Optional link per category (max 20, 128 characters per name).
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {metaCategories.map((row, index) => (
                    <div
                      key={index}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                        alignItems: 'center',
                      }}
                    >
                      <input
                        aria-labelledby="cats-label"
                        value={row.name}
                        onChange={(e) => setMetaCategoryRow(index, 'name', e.target.value)}
                        placeholder="Name"
                        style={{ flex: '1 1 10rem', minWidth: '8rem' }}
                      />
                      <input
                        value={row.url}
                        onChange={(e) => setMetaCategoryRow(index, 'url', e.target.value)}
                        placeholder="URL (optional)"
                        style={{ flex: '2 1 14rem', minWidth: '10rem' }}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => removeMetaCategoryRow(index)}
                        aria-label={`Remove category row ${index + 1}`}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginTop: '0.5rem' }}
                  onClick={addMetaCategoryRow}
                  disabled={metaCategories.length >= 20}
                >
                  Add category
                </button>
              </div>
              <label htmlFor="add">Added date (ISO or text)</label>
              <input id="add" value={metaAddedAt} onChange={(e) => setMetaAddedAt(e.target.value)} />
              <label htmlFor="tagdraft">Tags</label>
              <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
                Add labels for filtering and search (max 50 tags, 64 characters each).
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem' }}>
                {metaTags.map((t) => (
                  <span
                    key={t}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.2rem 0.5rem',
                      borderRadius: 6,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      fontSize: '0.9rem',
                    }}
                  >
                    {t}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '0 0.2rem', minHeight: 0, fontSize: '1rem', lineHeight: 1 }}
                      onClick={() => removeMetaTag(t)}
                      aria-label={`Remove tag ${t}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                <input
                  id="tagdraft"
                  value={metaTagDraft}
                  onChange={(e) => setMetaTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addMetaTag();
                    }
                  }}
                  placeholder="New tag"
                  style={{ flex: '1 1 12rem', minWidth: '8rem' }}
                />
                <button type="button" className="btn btn-ghost" onClick={addMetaTag}>
                  Add tag
                </button>
              </div>
              <label htmlFor="desc">Description (Markdown)</label>
              <textarea
                id="desc"
                rows={10}
                value={metaDescription}
                onChange={(e) => setMetaDescription(e.target.value)}
                style={{ width: '100%', fontFamily: 'monospace', marginBottom: '1rem' }}
              />
              <button type="button" className="btn btn-primary" onClick={() => void saveMetadata()}>
                Save metadata
              </button>
              {metaMsg ? <p style={{ color: 'var(--muted)', marginTop: '0.5rem' }}>{metaMsg}</p> : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
