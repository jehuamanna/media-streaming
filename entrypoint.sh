#!/bin/sh
set -e
mkdir -p /var/hls/live /var/hls/vod /var/run/nginx /data
nginx
exec node /app/server/index.js
