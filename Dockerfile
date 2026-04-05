FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    libnginx-mod-rtmp \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/hls/live /var/hls/vod /data /var/log/nginx

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY client/package.json client/vite.config.ts client/tsconfig.json client/tsconfig.app.json client/tsconfig.node.json client/index.html ./client/
COPY client/src ./client/src
RUN cd client && npm install && npm run build

COPY server ./server
RUN mkdir -p server/public && cp -r client/dist/* server/public/

ENV NODE_ENV=production
ENV PORT=8020
ENV VIDEOS_DIR=/Videos
ENV HLS_VOD_DIR=/var/hls/vod
ENV DATABASE_PATH=/data/app.db

EXPOSE 8020 1935

CMD ["/entrypoint.sh"]
