# Video Renderer Backend (local + Railway)

Node.js + Express + FFmpeg renderer for the slideshow frontend. Runs on your laptop, or
deployed on Railway; the frontend uploads images, one narration MP3 ZIP, effect
assignments and settings, and this service renders the final MP4.

## 1. Requirements

- Node.js 18 or newer
- FFmpeg (with `ffprobe`) available in `PATH`
  - Windows: download a static build (e.g. gyan.dev / BtbN), unzip, add the `bin` folder to PATH
  - Verify: `ffmpeg -version` and `ffprobe -version`
  - Alternatively set `FFMPEG_PATH` / `FFPROBE_PATH` to the full .exe paths

## 2. Install & run

```bash
npm install
npm start
```


Production: Railway assigns the PORT and public HTTPS domain automatically.

Health check:

```bash
Health check: open `https://YOUR-RAILWAY-DOMAIN/health`.
```

## 3. Deploy to Railway

This repo now ships with a `Dockerfile` and `railway.json`, so Railway builds it with
FFmpeg installed instead of the default Nixpacks build (which does not include FFmpeg —
`/render` would fail with `Cannot start ffmpeg (ffmpeg): spawn ffmpeg ENOENT` without it).

1. Push this folder to a GitHub repo (or use the Railway CLI from this folder directly —
   `railway up` — no GitHub needed).
2. On [railway.app](https://railway.app), create a new project → **Deploy from GitHub repo**
   (or confirm the CLI deploy). Railway detects `railway.json` and builds the `Dockerfile`
   automatically.
3. No environment variables are required to get it running — Railway injects `PORT`
   automatically, the server already binds to `0.0.0.0`, and `app.set("trust proxy", true)`
   plus the per-request `req.protocol` check means `/render` and `/stitch` already return
   an `https://your-app.up.railway.app/output/xxx.mp4` link once Railway's proxy is in
   front of it — not `https://YOUR-RAILWAY-DOMAIN`.
4. Optional but recommended: after the first deploy, copy the Railway-assigned domain and
   set it as a `PUBLIC_BASE` variable in the Railway dashboard, e.g.
   `PUBLIC_BASE=https://your-app.up.railway.app`. This isn't needed for `/render` or
   `/stitch` (they already work it out per-request), but it makes the `outputBase` field
   in `/health` accurate too, and acts as a safety net if a future proxy hop doesn't set
   `X-Forwarded-Proto`.
5. Health check: Railway will poll `GET /health` (already wired in `railway.json`) to know
   the deploy is healthy.

**Storage caveat:** Railway's filesystem is ephemeral. Files under `data/`, `output/`, and
`cache/` survive only as long as the current container is running — a redeploy, crash
restart, or manual restart wipes them. That's fine for the render → return link → download
flow, but don't treat `/output/*.mp4` as permanent storage; download or forward each video
soon after the job completes. If you need videos to survive restarts, attach a
[Railway Volume](https://docs.railway.com/reference/volumes) mounted at `/app/output`
(and `/app/data` if you also want uploaded projects to persist).

**Resource caveat:** rendering is CPU-bound and `MAX_CONCURRENT_FFMPEG` defaults to `1` on
purpose. Railway's free/Hobby plan has limited CPU and RAM — long or high-panel-count
renders may need a paid plan with more resources, or they'll simply take longer rather
than failing outright.

## 4. API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | status, ffmpeg availability, supported settings |
| POST | `/panel` | multipart image/audio upload (no application-level file-count or per-file-size cap; plus `project_id`) |
| POST | `/audio-zip` | multipart ZIP of numbered narration MP3s, field `audioZip` |
| GET | `/assets` | list local VFX/SFX libraries |
| POST | `/assets/vfx` | upload a local VFX video file |
| POST | `/assets/sfx` | upload a local SFX audio file |
| POST | `/render` | start an asynchronous render, returns `jobId` |
| GET | `/status/:jobId` | poll progress |

### POST /render (JSON)

```json
{
  "projectId": "PROJECT_ID",
  "settings": {
    "resolution": "1080p",
    "fps": 25,
    "vfx_enabled": true,
    "vfx_opacity": 0.8,
    "sfx_enabled": true,
    "sfx_volume": 0.1,
        "motion": "automatic",
    "transitions": "automatic"
  },
  "panels": [
    { "panel": 1, "image": "1.png", "audio": "1.mp3", "vfx": null, "sfx": null },
    { "panel": 24, "image": "24.png", "audio": "24.mp3", "vfx": "Fire_01", "sfx": "Explosion_02" }
  ]
}
```

Reply: `{ "jobId": "job_...", "status": "queued", "totalPanels": 2000 }`

Validation happens before FFmpeg starts. Missing images, missing narration numbers or
missing VFX/SFX library names are rejected with a clear error listing what is missing.

### GET /status/:jobId

```json
{
  "jobId": "job_abc",
  "status": "rendering",
  "stage": "rendering",
  "progress": 47,
  "currentPanel": 940,
  "totalPanels": 2000,
  "message": "Rendering panel 940 of 2000"
}
```

Stages: `queued`, `preparing`, `checking`, `preparing_vfx`, `rendering`, `finalizing`,
`complete`, `error`.

When complete the response includes:

```json
{ "videoUrl": "https://YOUR-RAILWAY-DOMAIN/output/job_abc_final.mp4" }
```

## 5. Settings

- `resolution`: `1080p` (1920x1080, default) or `720p` (1280x720)
- `fps`: `25` (default), `20`, `15`
- `vfx_opacity`: default `0.8` · `sfx_volume`: default `0.1` (explicit `0` is respected)
- motion and transitions are always automatic; the frontend does not choose them
- FFmpeg encoding details (codec, CRF, preset, pixel format) are backend-only

## 6. Local files

```
assets/vfx/     VFX library (Fire_01.mp4 -> library name "Fire_01")
assets/sfx/     SFX library (Explosion_02.mp3 -> "Explosion_02")
data/projects/  uploaded images + extracted narration per project
cache/vfx/      normalized VFX, prepared once per asset + resolution + fps
output/         final videos: <jobId>_final.mp4
```

Panel segments live in `data/projects/<id>/tmp/<jobId>/` and are deleted after the job
finishes (set `KEEP_TEMP=1` to keep them for debugging).

## 7. Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `PUBLIC_BASE` | auto-detected from the request (`https://...` on Railway) | overrides the returned video URL's base; only needed if auto-detection ever picks the wrong scheme/host |
| `MAX_CONCURRENT_FFMPEG` | `1` | concurrent FFmpeg process safety setting; leave at 1 on a laptop |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | explicit binary paths |
| `CRF` | `21` | quality |
| `X264_PRESET` | `veryfast` | CPU preset |
| `TRANSITION_SECONDS` | `0.5` | automatic transition length |
| `KEEP_TEMP` | unset | keep panel segments |

## 8. How the render works

1. Panel duration is read from that panel's narration MP3 (`ffprobe`).
2. Each unique VFX is inspected once; if it already matches the output resolution/fps it is
   used as-is, otherwise it is normalized once and cached — never per panel.
3. Each panel is rendered by one FFmpeg process: image + automatic motion (zoompan) +
   optional VFX (screen blend for black-background clips, alpha overlay when real alpha
   exists) + narration + optional SFX mixed at the chosen volume.
4. Automatic transitions are baked into that same pass as short fades, so final assembly is
   a stream-copy `concat` — the full video is never re-encoded a second time.
5. Output: H.264 / AAC / yuv420p / faststart, served from `/output`.

Only one FFmpeg process runs at a time by default, which keeps CPU use stable on an
i7-1185G7 / 16 GB laptop with integrated graphics (no GPU encoding is used).


VFX blend modes: `screen` (default), `lighten`, `overlay`, `addition` (UI: Add), `normal`, `difference`. The selected mode is applied during final FFmpeg rendering; VFX opacity remains independent.


### VFX behavior (current)
- VFX panels are rendered with a static base image (no automatic pan/zoom on panels that have VFX).
- VFX sources are used directly with no pre-render re-encode or `yuv420p` conversion; `yuv420p` is used only on the final MP4 output for compatibility.
- Image color filters have been removed from the backend. VFX compositing defaults to the selected blend mode (Screen by default) without a global color filter.


### VFX colour/compositing behavior
VFX sources are not pre-rendered or converted to `yuv420p` before compositing. The base image and VFX are blended in RGB (`gbrp/gbrap`) at render time to avoid YUV chroma-plane blending colour shifts. Panels with a VFX assignment use static image framing (no zoom/pan motion). The final delivery video is encoded as `yuv420p` only after compositing for normal MP4 compatibility.


## 9. Large project uploads

The backend no longer imposes application-level limits on the number of panel files,
individual panel-file size, narration ZIP size, or uploaded VFX/SFX asset size. Panel
files are written directly to disk rather than accumulated in RAM. Node request and
connection timeouts are disabled so very large local uploads are not cut off by the
server while they are still transferring.

There is intentionally still no artificial maximum panel count in the render pipeline.
The practical limits are the machine's available disk space, filesystem capacity, RAM,
CPU/GPU resources, FFmpeg capabilities, and the time required to render the project.
The FFmpeg concurrency setting remains serialized by default to avoid overwhelming a
laptop during large renders. Security-related filename/path sanitization remains in
place.
