import { useEffect, useRef, useState } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import { api, getToken } from '../api';

/** Keep in sync with server `ffmpegVodArgs` `-hls_time` (seconds per segment). */
const VOD_HLS_SEGMENT_TARGET_SEC = 6;

type Props = {
  src: string | null;
  fileId: string | null;
  /** When set (e.g. course queue), prefetched when the current item is within 10s of ending. */
  nextSrc?: string | null;
  nextFileId?: string | null;
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

function isVodHlsSrc(s: string) {
  return s.includes('/hls/vod/');
}

/** Warm HTTP cache: manifest + enough `.ts` segments to cover ~`secondsWanted` of media. */
async function prefetchVodSegments(hlsUrl: string, fileId: string, secondsWanted: number) {
  try {
    for (let i = 0; i < 24; i++) {
      const r = await api<{ playable: boolean }>(`/api/vod/playable/${encodeURIComponent(fileId)}`);
      if (r.playable) break;
      await new Promise((res) => setTimeout(res, 500));
    }
  } catch {
    return;
  }
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const manifestHref = new URL(hlsUrl, window.location.origin).href;
  let text: string;
  try {
    const res = await fetch(manifestHref, { headers });
    if (!res.ok) return;
    text = await res.text();
  } catch {
    return;
  }
  const segmentUrls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    segmentUrls.push(new URL(s, manifestHref).href);
  }
  const segCount = Math.max(1, Math.ceil(secondsWanted / VOD_HLS_SEGMENT_TARGET_SEC) + 1);
  for (let i = 0; i < Math.min(segCount, segmentUrls.length); i++) {
    try {
      await fetch(segmentUrls[i], { headers });
    } catch {
      /* ignore */
    }
  }
}

export function VideoPlayer({ src, fileId, nextSrc, nextFileId, onEnded }: Props) {
  const videoRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<VideoJsPlayer | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const [vodPreparing, setVodPreparing] = useState(false);

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
      html5: {
        vhs: {
          overrideNative: true,
          goalBufferLength: 10,
          maxBufferLength: 20,
        },
      },
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
      setVodPreparing(false);
      try {
        player.pause();
        player.reset();
      } catch {
        /* ignore */
      }
      return;
    }
    ensureVhsAuthAndTimeouts();
    let cancelled = false;
    const waitVodThenPlay = async () => {
      if (fileId && isVodHlsSrc(src)) {
        setVodPreparing(true);
        try {
          player.pause();
          player.reset();
        } catch {
          /* ignore */
        }
        try {
          for (;;) {
            if (cancelled) return;
            const r = await api<{ playable: boolean }>(
              `/api/vod/playable/${encodeURIComponent(fileId)}`,
            );
            if (r.playable) break;
            await new Promise((r) => setTimeout(r, 1500));
          }
        } catch {
          if (!cancelled) setVodPreparing(false);
          try {
            player.pause();
            player.reset();
          } catch {
            /* ignore */
          }
          return;
        }
        if (cancelled) return;
        setVodPreparing(false);
      }
      ensureVhsAuthAndTimeouts();
      player.src({ src, type: 'application/x-mpegURL' });
      if (fileId && isVodHlsSrc(src)) {
        void prefetchVodSegments(src, fileId, 10);
      }

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
    };
    void waitVodThenPlay();

    return () => {
      cancelled = true;
      setVodPreparing(false);
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

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !src || !nextSrc || !nextFileId) return;
    if (!isVodHlsSrc(nextSrc)) return;
    let cancelled = false;
    let fired = false;
    const onTime = () => {
      if (cancelled || fired) return;
      const d = player.duration() ?? NaN;
      const t = player.currentTime() ?? NaN;
      if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t)) return;
      if (d - t > 10) return;
      fired = true;
      void prefetchVodSegments(nextSrc, nextFileId, 10);
    };
    player.on('timeupdate', onTime);
    return () => {
      cancelled = true;
      player.off('timeupdate', onTime);
    };
  }, [src, nextSrc, nextFileId]);

  return (
    <div className="player-wrap" data-vjs-player>
      <div className="player-host" ref={videoRef} />
      {!src ? (
        <div className="player-placeholder">
          <span>Select a video</span>
        </div>
      ) : vodPreparing ? (
        <div className="player-placeholder">
          <span>Preparing playback (first play transcodes to HLS)…</span>
        </div>
      ) : null}
    </div>
  );
}
