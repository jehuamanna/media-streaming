# Media streaming (live RTMP + VOD HLS)

Node serves the React app and API on **8020**; nginx ingests **RTMP** on **1935** and writes live HLS to disk. VOD is transcoded from **`/streaming/Videos`** (hardcoded default; override with `VIDEOS_DIR` if needed).

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
     -v /streaming/Videos:/streaming/Videos:ro \
     -v media-streaming-data:/data \
     media-streaming:latest
   ```

3. Open **http://localhost:8020**, sign in as **`admin`** with `ADMIN_INITIAL_PASSWORD`, then change the password when prompted.

4. **Live streaming:** publish to `rtmp://<host>:1935/live/<stream_key>` (e.g. OBS). In the app, use **Live** and enter the same `<stream_key>`.

**Sidecar HLS cache:** To store transcoded HLS next to each video (so moving the whole course folder keeps the cache), set `VOD_HLS_LAYOUT=sidecar` and mount the library **read-write** (omit `:ro`), for example `-v /streaming/Videos:/streaming/Videos` plus `-e VOD_HLS_LAYOUT=sidecar`.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes (min 16 chars) | Secret for signing JWTs. |
| `ADMIN_INITIAL_PASSWORD` | Only when the DB has no admin yet | Bootstrap password for user `admin` (min 8 chars). Ignored after an admin exists. |
| `PORT` | No | HTTP port inside the container (default **8020**). |
| `VIDEOS_DIR` | No | Library root (default **`/streaming/Videos`**). |
| `HLS_VOD_DIR` | No | Cached VOD HLS output when using **`central`** layout (default **`/var/hls/vod`**). Also used for encoding lock files (`.locks`) in all layouts. |
| `VOD_HLS_LAYOUT` | No | **`central`** (default): HLS under `HLS_VOD_DIR/<fileId>/`. **`sidecar`**: HLS next to each video as `<name>.mp4.hls/` in the same folder as the source file—moves with the course folder and avoids re-transcoding when you relocate media; requires **write** access under `VIDEOS_DIR`. |
| `DATABASE_PATH` | No | SQLite file (default **`/data/app.db`**). Mount a volume on `/data` to persist users and progress. |

### Library layout

```
/streaming/Videos/
  <course>/                    # top-level folder = one “course” tile
    *.mp4, *.mkv, ...          # optional: media directly here (shown under “In this course”)
    <playlist>/                # optional: subfolder = separate playlist group
      ... media files, nested dirs allowed
```

With **`VOD_HLS_LAYOUT=sidecar`**, each transcoded file also has a sibling directory such as **`lesson.mp4.hls/`** (HLS manifest and segments). Copy or move those together with the source video if you relocate courses. The scanner only treats known video extensions as playable files; contents of `*.hls` dirs are ignored for indexing.

On the host, create **`/streaming/Videos`** (or bind another path to that mount target in Docker).

## Local development (without Docker)

From the repo root:

```bash
cd client && npm install && npm run build
mkdir -p ../server/public && cp -r dist/* ../server/public/
cd ../server && npm install
export JWT_SECRET='dev-secret-at-least-16'
export ADMIN_INITIAL_PASSWORD='devpass12345'
sudo mkdir -p /streaming/Videos
export VIDEOS_DIR='/streaming/Videos'
node index.js
```

For hot reload on the UI, run the Vite dev server in another terminal (`cd client && npm run dev`) and keep the API on 8020; Vite proxies `/api` and `/hls` to **http://127.0.0.1:8020** (see `client/vite.config.ts`).

## CI/CD (Jenkins)

The **[Jenkinsfile](Jenkinsfile)** pipeline:

1. **Checkout** SCM  
2. **Verify client build** — `docker run` with `node:20-bookworm-slim`, workspace mounted at `/ws`, runs `npm ci` and `npm run build` in `client/`. Set `SKIP_CLIENT_VERIFY=true` to skip.  
3. **Docker build** — `docker build` tagging `media-streaming:<branch>-<build>-<gitsha>` and `media-streaming:latest`. Override short name with env `IMAGE_NAME`.  
4. **Docker push** (optional) — only if `DOCKER_REGISTRY` is set (e.g. `ghcr.io/myorg`) **and** the branch is `main` or `master`. Requires username/password credentials whose ID defaults to `docker-registry` (override with `DOCKER_REGISTRY_CREDS_ID`). For `docker login`, the host is `DOCKER_LOGIN_HOST` if set, otherwise the first segment of `DOCKER_REGISTRY` (e.g. `ghcr.io`). Set `SKIP_DOCKER_PUSH=true` to disable pushing.

Create a **Multibranch Pipeline** or **Pipeline** job pointing at this repo. The agent needs the **Docker CLI** (and permission to run `docker` against a daemon) for verify and image build. The pipeline does **not** use the Docker Pipeline plugin’s `agent { docker { ... } }` block. If `docker run` fails (e.g. permissions on the workspace mount), set **`SKIP_CLIENT_VERIFY=true`** and rely on the Dockerfile’s internal client build.

### Optional: deploy container from Jenkins (Option B)

The pipeline **runs Deploy by default** (`RUN_DEPLOY_PARAM` defaults to **checked**). You should see in the log: `Deploy container stage will run: true`.

- **Image only (no container):** use **Build with Parameters** and **uncheck** the deploy checkbox, **or** set job env **`RUN_DEPLOY=false`**.
- **Force deploy** even if the box is unchecked: set **`RUN_DEPLOY=true`** on the job.

Then:

1. In Jenkins: **Manage Credentials** → add two **Secret text** entries (IDs must match unless you override):
   - **`media-streaming-jwt-secret`** — value at least **16** characters (`JWT_SECRET`).
   - **`media-streaming-admin-initial-password`** — at least **8** characters; only used when the **`/data`** volume has **no** admin user yet (otherwise the app ignores it).

2. Optional job env overrides: **`JWT_SECRET_CRED_ID`**, **`ADMIN_INITIAL_PASSWORD_CRED_ID`**, **`DEPLOY_CONTAINER_NAME`**, **`DEPLOY_VIDEOS_PATH`** (host path bound to **`/streaming/Videos`** in the container, default **`/streaming/Videos`**), **`DEPLOY_DATA_VOLUME`** (default `media-streaming-data`), **`DEPLOY_HOST_PORT_HTTP`**, **`DEPLOY_HOST_PORT_RTMP`**, **`DEPLOY_SKIP_RM=true`** to avoid removing an existing container first.

The stage runs **`docker run -d`** with **`${IMAGE_NAME}:latest`** (the tag produced by this pipeline).

### Jenkins: “No Docker images or containers”

- **Images are stored on the machine that ran the build** (the Jenkins agent: often the same server as the controller when the job uses `agent any`). Run `docker images media-streaming` **on that host** (e.g. SSH to the Jenkins server). They will **not** appear on your laptop unless you build or pull there.
- A successful pipeline **always builds an image**; it does **not** start a container unless **`RUN_DEPLOY=true`** is set on the job and the deploy credentials exist. Without that, **`docker ps`** will show no new container.
- **Push** runs only when **`DOCKER_REGISTRY`** is set and the branch is **main** or **master** (including `GIT_BRANCH` `origin/main` for a single Pipeline job).
