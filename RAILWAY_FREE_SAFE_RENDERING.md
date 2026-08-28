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
