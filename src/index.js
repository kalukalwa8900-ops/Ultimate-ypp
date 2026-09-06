"use strict";
const express = require("express");
const cors = require("cors");
const path = require("path");
const { DIRS, SERVER, DEFAULTS, ALLOWED_FPS, RESOLUTIONS } = require("./config");
const { ffmpegAvailable } = require("./lib/ffmpeg");

const app = express();

// Behind a reverse proxy (Railway, Render, etc.) the client connects over
// https but the proxy talks to us over plain http. Without this, req.protocol
// always reports "http" even when the real request was https, which breaks
// the video URLs we generate below (see publicBaseFor()).
app.set("trust proxy", true);

app.use(cors());
app.use(express.json({ limit: "2gb" }));
app.use(express.urlencoded({ extended: true, limit: "2gb" }));

// Final videos are served from the Railway service over its public HTTPS domain.
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
    defaults: DEFAULTS,
    outputBase: `${SERVER.publicBase}/output`,
  });
});

app.use(require("./routes/panel"));
app.use(require("./routes/audioZip"));
app.use(require("./routes/assets"));
app.use(require("./routes/render"));
app.use(require("./routes/stitch"));

app.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err.message);
  res.status(err.status || 400).json({ error: err.message });
});

const server = app.listen(SERVER.port, SERVER.host, async () => {
  const ok = await ffmpegAvailable();
  console.log(`video-renderer-backend listening on ${process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `port ${SERVER.port}`}`);
  console.log(`output dir: ${path.relative(process.cwd(), DIRS.output)}`);
  if (!ok) console.warn("WARNING: ffmpeg/ffprobe not found in PATH — install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH");
});

// Large local uploads should not be terminated by Node's default 5-minute
// request timeout while thousands of files are being transferred.
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 0;
