# Railway Free Video Render Backend

Defaults:
- Output: 1280x720
- FPS: 20
- Video threads: 2
- Filter threads: 1
- VFX opacity: 60%
- SFX volume: 8%
- Transitions: disabled

Rendering:
1. Image + panel narration audio
2. Ken Burns motion
3. Optional reusable range VFX overlays
4. Optional reusable range SFX layers
5. Encode one panel
6. Join finished panels with concat stream-copy

VFX assets are normalized once to 1280x720 / 20fps and cached in `vfx-library/cache`.
SFX layers are looped quietly under narration.
No xfade/transition filter is used.

Example range layers sent in `vfxLayers` / `sfxLayers` JSON:
```json
[
  {"name":"magic.webm","startPanel":10,"endPanel":20,"opacity":0.6},
  {"name":"sword.mp4","startPanel":30,"endPanel":35,"opacity":0.6}
]
```
SFX:
```json
[
  {"name":"wind.mp3","startPanel":1,"endPanel":20,"volume":0.08}
]
```
The `name`/`file` can be a saved library filename or a path the backend can resolve.
