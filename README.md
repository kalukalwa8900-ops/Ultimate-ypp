# Slideshow Studio — Render Backend

FFmpeg-based render backend for the Slideshow Studio frontend. Implements exactly the
endpoints the frontend calls (`src/lib/renderer.ts`):

| Method | Path             | Purpose |
| ------ | ---------------- | ------- |
| GET    | `/health`        | health check (`{ ok: true }`) |
| POST   | `/panel`         | multipart upload of one panel: `image`, optional `audio`, plus fields (`project_id`, `panel_id`, `index`, `duration`, `zoom`, `cropX`, `cropY`, `motion`, `transition`, `fps`, `cinematic`, `vfx_N`, `sfx_N`, `vfx_N_url`, `sfx_N_url`, fit fields) |
| POST   | `/audio-zip`     | multipart `audioZip` + `project_id` — MP3s are sorted naturally and attached to panels in order (or by the number found in the filename) |
| POST   | `/render`        | JSON **or** multipart (`payload` + `overlay` logo). Returns `{ jobId }` |
| GET    | `/status/:jobId` | `{ status: queued\|rendering\|done\|error, progress, url }` |
| POST   | `/stitch`        | `{ urls: [...] }` → downloads parts and concatenates them (stream copy) into one MP4 |
| GET    | `/files/:name`   | serves rendered MP4s |

No authentication — same as the frontend expects. CORS is fully open.

## Features

- Per-panel Ken Burns **motion**: Static, Slow Zoom In/Out, Slow Push In, Slow Pull Back,
  Pan Left/Right/Up/Down, Focus Push, Fast Push, Fast Pan, Shake.
- **Transitions**: Hard Cut, Cross Dissolve, Fade To Black, Fade From Black, Impact Cut, Flash Cut
  (xfade + acrossfade; clip lengths are padded by the transition duration so narration stays in sync).
- **VFX** overlay videos (looped, per-layer opacity, default 60%) and **SFX** audio
  (mixed under narration, default volume 8%).
- Output fit: `cover`, `contain`, `blur-pad`; per-panel manual zoom / crop focus.
- Duration follows the narration MP3 when present, otherwise the requested duration.
- Compression presets (`small` / `balanced` / `high`), optional loudness normalization,
  optional watermark/logo overlay.
- Output: 1920×1080 H.264 + AAC, `+faststart`.

## Run locally

```bash
npm install
npm start          # http://localhost:8080
```

Requires `ffmpeg` and `ffprobe` on PATH (the Dockerfile installs them).

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway detects the `Dockerfile` (ffmpeg is installed inside it) and builds automatically.
4. Under **Settings → Networking**, click **Generate Domain**.
5. Copy the resulting `https://<your-app>.up.railway.app` URL into the app
   (Render tab → backend URL, or per-project backend URL).

### Environment variables (all optional)

| Variable        | Default            | Notes |
| --------------- | ------------------ | ----- |
| `PORT`          | `8080`             | Railway sets this automatically |
| `DATA_DIR`      | `/tmp/render-data` | working + output directory |
| `PUBLIC_URL`    | auto-detected      | set if the returned file URLs must be forced to a specific origin |
| `MAX_UPLOAD_MB` | `200`              | per-file upload limit |
| `RETENTION_MIN` | `240`              | minutes before rendered files / projects are cleaned up |

Storage is ephemeral on Railway — rendered files live long enough to download
(the frontend downloads them automatically when a render finishes).

## Scaling

Deploy this same repo several times (or several Railway services) and paste each URL
into the frontend's renderer list; the app splits panels across all of them and calls
`/stitch` on the first one to join the parts.
