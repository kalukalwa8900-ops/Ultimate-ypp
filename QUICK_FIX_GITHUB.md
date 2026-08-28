# Railway deployment note

Commit the complete backend directory to the Git repository used by Railway.
Do not delete `index.js` or `Dockerfile`.

The renderer defaults to 1280x720 at 20 FPS and uses a conservative FFmpeg thread configuration for a 2-vCPU / 1-GB-RAM service.
