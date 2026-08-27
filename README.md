# Video Renderer Backend 2.5 — Cinematic Layer

FFmpeg-based render service for the Novel Recap Video Editor. Version 2.5 adds a
**cinematic layer** on top of the existing pipeline (panel upload → narration/TTS →
segment render → concat). **All 2.3 payloads keep working unchanged** — every new
field is optional and falls back to the legacy behaviour.

## Run

```bash
npm install
npm start            # PORT (default 3000), needs ffmpeg + ffprobe on PATH
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness + ffmpeg availability |
| POST | `/panel` | Upload one panel (image + narration/audio) — now accepts cinematic fields |
| POST | `/audio-zip` | Bulk narration audio upload (unchanged) |
| POST | `/render` | Start a full render, returns `{ jobId }` |
| POST | `/render/preview` | **New.** Render only panels `fromPanel..toPanel` (1-based, inclusive) |
| GET | `/status/:jobId` | Job progress, `warnings[]`, result URL |
| POST | `/assets/vfx` | **New.** Upload a VFX asset (multipart `file` + `name`) |
| POST | `/assets/sfx` | **New.** Upload an SFX/BGM asset (multipart `file` + `name`) |
| GET | `/assets` | **New.** List both asset libraries |

Asset uploads are keyed by a **normalized semantic name** (`magic_blast`,
`sword_slash`, …) and are idempotent: re-uploading the same name replaces the file.
The frontend syncs every referenced asset before calling `/render`.

## Panel fields (`POST /panel`)

Cinematic fields may arrive as nested JSON or flat form fields — both are accepted:

```
motion      "Slow Push In"
transition  "Impact Cut"
cinematic   {"motion":…,"transition":…,"vfx":{…},"sfx":{…}}
vfx         {"name":"magic_blast","mode":"EVENT","offset":3.1,"enabled":true,"opacity":0.5}
sfx         {"name":"magic_blast","offset":3.1,"volume":0.1,"enabled":true}
```

Flat equivalents: `vfxName`/`vfx_name`, `vfxMode`, `vfxOffset`, `vfxOpacity`,
`sfxName`/`sfx_name`, `sfxOffset`, `sfxVolume`.

- **VFX** — `mode: "EVENT"` composites the effect once at `offset` seconds from the
  panel start; `"CONTINUOUS"` loops it across the whole panel. Default opacity `0.5`.
  Alpha-capable sources (WebM/VP9, MOV ProRes 4444, APNG, GIF) are composited with
  their alpha; other files are screen-blended.
- **SFX** — delayed to `panel_start + offset` and mixed under the narration at
  `volume` (linear, default `0.1`).
- A name with no matching asset in the library renders the panel **clean** and adds
  an entry to the job's `warnings[]` — it never fails the render.

## Render options (`POST /render`, `POST /render/preview`)

New optional keys (camelCase and snake_case both accepted):

```
vfxGlobal / vfx_global      master VFX switch (default true)
sfxGlobal / sfx_global      master SFX switch (default true)
vfxRanges / vfx_ranges      [{ id, name, fromPanel, toPanel, opacity }]
bgmRanges / bgm_ranges      [{ id, track, fromPanel, toPanel, volume }]
fromPanel, toPanel          1-based inclusive panel window (preview renders)
```

`vfxRanges` apply a CONTINUOUS effect across a panel span; `bgmRanges` mix a music
track (resolved from the SFX library) across a span, ducked under the narration
(default `0.1`). BGM is deliberately section-level, never per panel.

## Vocabulary (`cinematic.js`)

Exact strings shared with the frontend and the AI script. Anything else falls back
to `Static` / `Hard Cut`.

**MOTION_MAP** — Static · Slow Zoom In · Slow Zoom Out · Slow Push In · Slow Pull
Back · Pan Left · Pan Right · Pan Up · Pan Down · Focus Push · Fast Push · Fast Pan
· Shake

**TRANSITION_MAP** — Hard Cut · Cross Dissolve · Fade To Black · Fade From Black ·
Impact Cut (fast zoom punch + hard cut) · Flash Cut (2-frame white flash)

When every panel uses `Hard Cut`, concat stays on the fast stream-copy path; any
other transition triggers an `xfade` re-encode, with an automatic fallback to
stream-copy if `xfade` fails.

## Tuning (`motion.config.json`)

Motion strengths and transition timings are data, not hard-coded: zoom percentages,
pan distances, shake amplitude, transition durations, and the VFX/SFX/BGM defaults
all live in `motion.config.json`. Edit and restart — no code change needed.

## Safety notes

- All user-supplied values interpolated into FFmpeg filter graphs go through the
  `escFilterArg` / `escFilterPath` helpers in `cinematic.js`.
- Concurrent FFmpeg spawns are bounded by `MAX_CONCURRENT_FFMPEG`.
- Finished jobs are evicted past a cap; temp files are removed on failure paths.
