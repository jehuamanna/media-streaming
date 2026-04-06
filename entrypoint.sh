#!/bin/sh
set -e
mkdir -p /var/hls/live /var/hls/vod /var/run/nginx /data

nginx -t

# Foreground master under a shell job so we can confirm it stayed up; avoids daemon-only edge cases.
nginx -g "daemon off;" &
nginx_pid=$!

sleep 0.2
if ! kill -0 "$nginx_pid" 2>/dev/null; then
  echo "entrypoint: nginx exited during startup (RTMP on 1935 unavailable). See /var/log/nginx/error.log" >&2
  exit 1
fi

exec node /app/server/index.js
