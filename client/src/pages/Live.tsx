import { useMemo, useState } from 'react';
import { VideoPlayer } from '../components/VideoPlayer';

export default function Live() {
  const [stream, setStream] = useState('');
  const [playing, setPlaying] = useState('');

  const src = useMemo(() => {
    if (!playing.trim()) return null;
    const name = encodeURIComponent(playing.trim());
    return `/hls/live/${name}/index.m3u8`;
  }, [playing]);

  return (
    <div className="app-shell">
      <h1>Live (RTMP)</h1>
      <p className="live-hint">
        Publish to <code>rtmp://&lt;host&gt;:1935/live/&lt;stream_key&gt;</code> then enter the same stream key
        below.
      </p>
      <div className="form-panel" style={{ maxWidth: 480 }}>
        <label htmlFor="sk">Stream key</label>
        <input id="sk" value={stream} onChange={(e) => setStream(e.target.value)} placeholder="mystream" />
        <button type="button" className="btn btn-primary" onClick={() => setPlaying(stream)}>
          Play
        </button>
      </div>
      <div style={{ marginTop: '1.25rem' }}>
        <VideoPlayer src={src} fileId={null} />
      </div>
    </div>
  );
}
