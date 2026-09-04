"use strict";
const express = require("express");
const cors = require("cors");
const path = require("path");
const { DIRS, SERVER, DEFAULTS, ALLOWED_FPS, RESOLUTIONS, FILTERS } = require("./config");
const { ffmpegAvailable } = require("./lib/ffmpeg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Final videos are served over plain HTTP from the local machine.
app.use("/output", express.static(DIRS.output, { maxAge: 0 }));

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    service: "video-renderer-backend",
    version: "3.0.0",
    ffmpeg: await ffmpegAvailable(),
    maxConcurrentFfmpeg: SERVER.maxConcurrentFfmpeg,
    resolutions: Object.keys(RESOLUTIONS),
    fps: ALLOWED_FPS,
    filters: Object.keys(FILTERS),
    defaults: DEFAULTS,
    outputBase: `${SERVER.publicBase}/output`,
  });
});

app.use(require("./routes/panel"));
app.use(require("./routes/audioZip"));
app.use(require("./routes/assets"));
app.use(require("./routes/render"));

app.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err.message);
  res.status(err.status || 400).json({ error: err.message });
});

app.listen(SERVER.port, SERVER.host, async () => {
  const ok = await ffmpegAvailable();
  console.log(`video-renderer-backend listening on http://localhost:${SERVER.port}`);
  console.log(`output dir: ${path.relative(process.cwd(), DIRS.output)}`);
  if (!ok) console.warn("WARNING: ffmpeg/ffprobe not found in PATH — install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH");
});
