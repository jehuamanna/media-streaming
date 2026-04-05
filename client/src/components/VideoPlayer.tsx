import { useEffect, useRef } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import { api, getToken } from '../api';

type Props = {
  src: string | null;
  fileId: string | null;
  onEnded?: () => void;
};

type VideoJsPlayer = ReturnType<typeof videojs>;

let vhsOnRequestInstalled = false;

/**
 * VHS uses xhr with a 45s default timeout. The server blocks on index.m3u8 until
 * ffmpeg finishes the full VOD transcode, which can exceed that. The deprecated
 * beforeRequest hook is also removed from the hook set after each XHR; use onRequest.
 */
function ensureVhsAuthAndTimeouts() {
  if (vhsOnRequestInstalled) return;
  const Vhs = (videojs as unknown as { Vhs?: { xhr?: { onRequest?: (fn: (o: unknown) => unknown) => void } } })
    .Vhs;
  const onRequest = Vhs?.xhr?.onRequest;
  if (!onRequest) return;
  onRequest((options: unknown) => {
    const o = options as { uri?: string; headers?: Record<string, string>; timeout?: number };
    const token = getToken();
    if (token) {
      o.headers = { ...o.headers };
      o.headers.Authorization = `Bearer ${token}`;
    }
    const uri = o.uri;
    if (typeof uri === 'string' && (uri.includes('/hls/vod/') || uri.includes('/hls/live/'))) {
      o.timeout = 0;
    }
    return o;
  });
  vhsOnRequestInstalled = true;
}

export function VideoPlayer({ src, fileId, onEnded }: Props) {
  const videoRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<VideoJsPlayer | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    if (!videoRef.current) return;
    ensureVhsAuthAndTimeouts();
    const container = videoRef.current;
    const el = document.createElement('video-js');
    el.classList.add('vjs-big-play-centered');
    container.appendChild(el);
    const player = videojs(el, {
      controls: true,
      responsive: true,
      fluid: false,
      fill: true,
      html5: { vhs: { overrideNative: true } },
    });
    playerRef.current = player;
    player.on('ended', () => onEndedRef.current?.());

    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!src) {
      try {
        player.pause();
        player.reset();
      } catch {
        /* ignore */
      }
      return;
    }
    ensureVhsAuthAndTimeouts();
    player.src({ src, type: 'application/x-mpegURL' });
    let cancelled = false;

    (async () => {
      if (!fileId) return;
      try {
        const r = await api<{
          progress: { position_seconds: number; duration_seconds: number | null } | null;
        }>(`/api/progress?fileId=${encodeURIComponent(fileId)}`);
        if (cancelled || !r.progress) return;
        const pos = r.progress.position_seconds;
        const dur = r.progress.duration_seconds;
        if (pos > 1 && (!dur || pos < dur - 2)) {
          player.one('loadedmetadata', () => {
            try {
              player.currentTime(pos);
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src, fileId]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !fileId) return;
    let lastSent = 0;
    const send = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSent < 8000) return;
      const t = player.currentTime() ?? 0;
      const d = player.duration() ?? NaN;
      if (!Number.isFinite(t) || t < 0) return;
      lastSent = now;
      void api('/api/progress', {
        method: 'PUT',
        json: {
          fileId,
          positionSeconds: t,
          durationSeconds: Number.isFinite(d) ? d : undefined,
        },
      }).catch(() => {});
    };
    const interval = window.setInterval(() => send(false), 12000);
    const onPause = () => send(true);
    const onEnded = () => send(true);
    player.on('pause', onPause);
    player.on('ended', onEnded);
    return () => {
      clearInterval(interval);
      player.off('pause', onPause);
      player.off('ended', onEnded);
    };
  }, [fileId]);

  return (
    <div className="player-wrap" data-vjs-player>
      <div className="player-host" ref={videoRef} />
      {!src ? (
        <div className="player-placeholder">
          <span>Select a video</span>
        </div>
      ) : null}
    </div>
  );
}
