# Video Renderer Backend (local)

Node.js + Express + FFmpeg renderer for the slideshow frontend. Runs on your laptop; the
frontend uploads images, one narration MP3 ZIP, effect assignments and settings, and this
service renders the final MP4.

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

Windows shortcut: double-click `start.bat`.

Server: `http://localhost:8080` (change with `PORT`).

Health check:

```bash
curl http://localhost:8080/health
```

## 3. API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | status, ffmpeg availability, supported settings |
| POST | `/panel` | multipart image upload (any number of files, plus `project_id`) |
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
    "filter": "none",
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
{ "videoUrl": "http://localhost:8080/output/job_abc_final.mp4" }
```

## 4. Settings

- `resolution`: `1080p` (1920x1080, default) or `720p` (1280x720)
- `fps`: `25` (default), `20`, `15`
- `vfx_opacity`: default `0.8` · `sfx_volume`: default `0.1` (explicit `0` is respected)
- `filter`: `none` (default), `warm`, `cool`, `cinematic`, `bw`
- motion and transitions are always automatic; the frontend does not choose them
- FFmpeg encoding details (codec, CRF, preset, pixel format) are backend-only

## 5. Local files

```
assets/vfx/     VFX library (Fire_01.mp4 -> library name "Fire_01")
assets/sfx/     SFX library (Explosion_02.mp3 -> "Explosion_02")
data/projects/  uploaded images + extracted narration per project
cache/vfx/      normalized VFX, prepared once per asset + resolution + fps
output/         final videos: <jobId>_final.mp4
```

Panel segments live in `data/projects/<id>/tmp/<jobId>/` and are deleted after the job
finishes (set `KEEP_TEMP=1` to keep them for debugging).

## 6. Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `PUBLIC_BASE` | `http://localhost:8080` | base used for the returned video URL |
| `MAX_CONCURRENT_FFMPEG` | `1` | keep at 1 on a laptop |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | explicit binary paths |
| `CRF` | `21` | quality |
| `X264_PRESET` | `veryfast` | CPU preset |
| `TRANSITION_SECONDS` | `0.5` | automatic transition length |
| `KEEP_TEMP` | unset | keep panel segments |

## 7. How the render works

1. Panel duration is read from that panel's narration MP3 (`ffprobe`).
2. Each unique VFX is inspected once; if it already matches the output resolution/fps it is
   used as-is, otherwise it is normalized once and cached — never per panel.
3. Each panel is rendered by one FFmpeg process: image + automatic motion (zoompan) +
   optional VFX (screen blend for black-background clips, alpha overlay when real alpha
   exists) + narration + optional SFX mixed at the chosen volume + optional light filter.
4. Automatic transitions are baked into that same pass as short fades, so final assembly is
   a stream-copy `concat` — the full video is never re-encoded a second time.
5. Output: H.264 / AAC / yuv420p / faststart, served from `/output`.

Only one FFmpeg process runs at a time by default, which keeps CPU use stable on an
i7-1185G7 / 16 GB laptop with integrated graphics (no GPU encoding is used).
