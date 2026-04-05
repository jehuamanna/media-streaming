# Media streaming (live RTMP + VOD HLS)

Node serves the React app and API on **8020**; nginx ingests **RTMP** on **1935** and writes live HLS to disk. VOD is transcoded from a mounted **`Videos/`** tree.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (recommended), or Node 20 + ffmpeg + nginx with RTMP for local dev.

## Run with Docker

1. Build the image (from the repository root):

   ```bash
   docker build -t media-streaming:latest .
   ```

2. Run the container:

   ```bash
   docker run --rm \
     -e JWT_SECRET='replace-with-a-long-random-secret-at-least-16-chars' \
     -e ADMIN_INITIAL_PASSWORD='replace-with-strong-temp-password-min-8' \
     -p 8020:8020 \
     -p 1935:1935 \
     -v /absolute/path/to/Videos:/Videos:ro \
     -v media-streaming-data:/data \
     media-streaming:latest
   ```

3. Open **http://localhost:8020**, sign in as **`admin`** with `ADMIN_INITIAL_PASSWORD`, then change the password when prompted.

4. **Live streaming:** publish to `rtmp://<host>:1935/live/<stream_key>` (e.g. OBS). In the app, use **Live** and enter the same `<stream_key>`.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes (min 16 chars) | Secret for signing JWTs. |
| `ADMIN_INITIAL_PASSWORD` | Only when the DB has no admin yet | Bootstrap password for user `admin` (min 8 chars). Ignored after an admin exists. |
| `PORT` | No | HTTP port inside the container (default **8020**). |
| `VIDEOS_DIR` | No | Library root (default **`/Videos`**). |
| `HLS_VOD_DIR` | No | Cached VOD HLS output (default **`/var/hls/vod`**). |
| `DATABASE_PATH` | No | SQLite file (default **`/data/app.db`**). Mount a volume on `/data` to persist users and progress. |

### Library layout

```
Videos/
  <course>/           # top-level folder = one “course” tile
    <playlist>/       # immediate subfolder = playlist group
      ... media files (mp4, mkv, webm, mov), nested dirs allowed
```

## Local development (without Docker)

From the repo root:

```bash
cd client && npm install && npm run build
mkdir -p ../server/public && cp -r dist/* ../server/public/
cd ../server && npm install
export JWT_SECRET='dev-secret-at-least-16'
export ADMIN_INITIAL_PASSWORD='devpass12345'
export VIDEOS_DIR="$(pwd)/../Videos"
node index.js
```

For hot reload on the UI, run the Vite dev server in another terminal (`cd client && npm run dev`) and keep the API on 8020; Vite proxies `/api` and `/hls` to **http://127.0.0.1:8020** (see `client/vite.config.ts`).

## CI/CD

See **[Jenkinsfile](Jenkinsfile)** at the repository root. The pipeline can verify the client build, build the Docker image, and optionally push to a registry when credentials and environment variables are configured (details in the Jenkinsfile header comment).
