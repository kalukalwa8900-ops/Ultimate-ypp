# Railway-safe rendering notes

Defaults:
- 1280x720
- 20 FPS
- FFmpeg encoder threads: 2
- filter threads: 1
- one render job at a time
- no visual transitions / xfade
- panel MP4s are joined with stream copy

Cinematic VFX:
- VFX assets supplied by the frontend can be cached in `temp/vfx-cache`.
- Each unique VFX source is normalized once to the requested output resolution/FPS.
- Cached VFX is reused for panels.
- The VFX still must be composited into a panel, so a panel containing VFX is encoded once. The final 300–500 panel join does not re-encode the whole video.

Important frontend contract:
- `/panel` accepts optional `vfx`, `sfx`, `motion`, and `cinematic` metadata.
- `/render` accepts `fps`, `width`/`height` or `resolution`, plus optional `vfxLibrary`, `sfxLibrary`, `vfxRanges`, and `sfxRanges`.
- Library assets can be uploaded through `/library/asset` with `type=vfx` or `type=sfx`.

If an instructed VFX/SFX cannot be resolved to a local backend file, rendering fails clearly instead of silently skipping the panel.


## Current Railway-safe fixes

- Final output defaults to 1280x720 at 20 FPS.
- Unless `ALLOW_HIGHER_RESOLUTION=1` is explicitly set, the backend caps output to 1280x720. This prevents a frontend mistake from silently starting a 1080p/4K render.
- Panel encoding explicitly uses `-threads:v 2`, `-threads:a 1`, `-filter_threads 1`, `-filter_complex_threads 1`, and x264 `threads=2`.
- No xfade or visual transition processing is used.
- Ken Burns motion is rendered per panel only.
- VFX is normalized once and cached at the requested output size/FPS, then reused.
- VFX is composited into a panel only when requested. Such a panel necessarily gets one encode; the final join does not re-encode the complete video.
- SFX is mixed at a default volume of 8%.
- VFX defaults to 60% opacity.
- Panel duration follows the narration/audio duration without artificial padding.
- Failed panel encoding is not retried automatically, preventing a resource failure from immediately starting the same expensive FFmpeg job again.
- Audio ZIP extraction avoids creating a large Node Buffer where the ZIP library supports direct extraction.
- One heavy render job is processed at a time.

### Important Railway build note

A Railway error such as:

`failed to do request: Head "https://registry-1.docker.io/v2/library/node/.../manifests/..."`

is a Docker Hub registry/network failure during image build, not an FFmpeg render failure. Redeploying the same source after the registry recovers is appropriate. If the build log instead reaches `npm install` or `RUN ffmpeg ...`, then investigate the application/container itself.
