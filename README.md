# Novel Recap Render Backend

Railway-ready Node.js + FFmpeg backend for the existing frontend.

- Ordered image + MP3 panel rendering
- Per-panel VFX/SFX/motion/transition instructions
- VFX opacity default 60%
- SFX volume default 8%
- Optional range/loop assets supplied by frontend
- 20 FPS default, user selectable
- 720p default, configurable output size
- Safer FFmpeg resource usage for Railway
- MP4 output

Key performance fix: motion rendering no longer feeds a full FPS image stream into `zoompan` while also using a frame-count `d` value. That pattern can multiply work dramatically. Motion now starts from one source image frame.

Environment variables:
PORT=8080
DATA_DIR=/tmp/render-data
FFMPEG_THREADS=2
FFMPEG_PRESET=veryfast
FFMPEG_CRF=20
XFADE_CHUNK_SIZE=30
MAX_UPLOAD_MB=200
RETENTION_MIN=240
