const express = require("express");
const multer = require("multer");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();
const PORT = process.env.PORT || 8080;
const RENDERER_NAME = process.env.RENDERER_NAME || "renderer";

// Railway Free: keep the Node process from competing with FFmpeg for memory.
if (!process.env.NODE_OPTIONS) process.env.NODE_OPTIONS = "--max-old-space-size=512";

// ================================
// FFmpeg Detection & Validation
// ================================

function validateFFmpegInstallation() {
  const possiblePaths = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/ffmpeg/bin/ffmpeg",
    "ffmpeg"
  ];

  let foundPath = null;
  for (const ffmpegPath of possiblePaths) {
    try {
      const result = execSync(`${ffmpegPath} -version 2>&1`, { encoding: "utf-8" });
      if (result.includes("ffmpeg version")) {
        foundPath = ffmpegPath;
        console.log(`✓ FFmpeg found at: ${ffmpegPath}`);
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (!foundPath) {
    console.error("❌ CRITICAL: FFmpeg is NOT installed!");
    process.exit(1);
  }

  return foundPath;
}

const FFMPEG_PATH = validateFFmpegInstallation();
const FFPROBE_PATH = FFMPEG_PATH.replace("ffmpeg", "ffprobe");

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

console.log(`✓ FFmpeg Path: ${FFMPEG_PATH}`);
console.log(`✓ FFprobe Path: ${FFPROBE_PATH}`);
console.log(`✓ Railway-safe renderer: resolution capped at 1280x720 unless ALLOW_HIGHER_RESOLUTION=1`);
console.log(`✓ FFmpeg video threads: 2 | filter threads: 1 | concurrent render jobs: 1`);

// ================================
// Middleware
// ================================

app.use(cors());

// FIX #2: Increase Request Limits
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

// ================================
// No Token Authentication (Development/Testing)
// ================================

app.use((req, res, next) => {
  next();
});

// ================================
// Directories
// ================================

const UPLOADS_ROOT = path.join(__dirname, "uploads");
const OUTPUT_ROOT  = path.join(__dirname, "output");
const TEMP_ROOT    = path.join(__dirname, "temp");

[UPLOADS_ROOT, OUTPUT_ROOT, TEMP_ROOT].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ================================
// In-Memory Job Store
// ================================

const jobs = {};

function createJob() {
  const jobId = crypto.randomBytes(8).toString("hex");
  jobs[jobId] = {
    status: "queued",
    progress: 0,
    url: null,
    error: null,
    createdAt: new Date()
  };
  return jobId;
}

function updateJob(jobId, patch) {
  if (jobs[jobId]) Object.assign(jobs[jobId], patch);
}

function scheduleJobEviction(jobId) {
  setTimeout(() => { delete jobs[jobId]; }, 3 * 60 * 60 * 1000);
}

// Railway Free safety: only one heavy render job runs at a time.
const renderQueue = [];
let renderActive = false;

function enqueueRender(jobId, task) {
  renderQueue.push({ jobId, task });
  updateJob(jobId, { status: "queued", queuePosition: renderQueue.length });
  drainRenderQueue();
}

async function drainRenderQueue() {
  if (renderActive || !renderQueue.length) return;
  renderActive = true;
  const item = renderQueue.shift();
  try {
    await item.task();
  } catch (err) {
    console.error(`[${item.jobId}] queued render error:`, err);
    updateJob(item.jobId, { status: "error", error: err.message });
    scheduleJobEviction(item.jobId);
  } finally {
    renderActive = false;
    renderQueue.forEach((q, i) => updateJob(q.jobId, { queuePosition: i + 1 }));
    setImmediate(drainRenderQueue);
  }
}

// ================================
// Helpers
// ================================

function safeName(value, fallback) {
  const raw = String(value || fallback || "").trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || fallback;
}

function extFor(file, fallback) {
  const original = file?.originalname ? path.extname(file.originalname) : "";
  if (original) return original.toLowerCase();

  const mime = (file?.mimetype || "").toLowerCase();
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png"))  return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("wav"))  return ".wav";
  if (mime.includes("mpeg")) return ".mp3";
  if (mime.includes("mp3"))  return ".mp3";
  if (mime.includes("mp4"))  return ".mp4";
  return fallback;
}

function wrapText(text, maxW = 44) {
  if (!text || !text.trim()) return "";

  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxW) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word.slice(0, maxW);
    }
  }

  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function cleanupFiles(files = []) {
  files.forEach((file) => {
    try { fs.unlinkSync(file); } catch (_) {}
  });
}

// ================================
// Get Audio Duration (with fallback)
// ================================

function getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(audioPath)) {
      return resolve({ valid: false, reason: "Audio file does not exist" });
    }

    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const audioStream = data.streams?.find(s => s.codec_type === "audio");
      if (!audioStream) {
        return resolve({ valid: false, reason: "No audio stream found" });
      }

      const duration = parseFloat(
        audioStream.duration ||
        data.format?.duration ||
        0
      );

      if (!duration || duration <= 0) {
        return resolve({ valid: false, reason: "Invalid audio duration" });
      }

      resolve({ valid: true, duration });
    });
  });
}

// ================================
// Get Image Dimensions
// ================================

function getImageDimensions(imagePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(imagePath)) {
      return resolve({ valid: false, reason: "Image file does not exist" });
    }

    ffmpeg.ffprobe(imagePath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const videoStream = data.streams?.find(s => s.codec_type === "video");
      if (!videoStream) {
        return resolve({ valid: false, reason: "No image stream found" });
      }

      const width = videoStream.width || 0;
      const height = videoStream.height || 0;

      if (!width || !height) {
        return resolve({ valid: false, reason: "Could not determine image dimensions" });
      }

      const aspectRatio = width / height;
      resolve({
        valid: true,
        width,
        height,
        aspectRatio
      });
    });
  });
}

// ================================
// Calculate Panel Duration (with priority order)
// ================================

async function calculatePanelDuration(panel) {
  const PADDING = 0;

  // Priority 1: ZIP MP3 audio (actual duration)
  if (panel.audio && panel.audio_source === "zip") {
    const audioPath = path.join(panel.dir, panel.audio);
    const result = await getAudioDuration(audioPath);
    if (result.valid) {
      const duration = result.duration + PADDING;
      console.log(`[panel ${panel.index + 1}] ${panel.audio} → ${result.duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
      return duration;
    } else {
      throw new Error(`Panel ${panel.index + 1} audio corrupted: ${result.reason}`);
    }
  }

  // Priority 2: Edge TTS duration (from metadata)
  if (panel.tts_duration && panel.tts_provider === "edge") {
    const duration = panel.tts_duration + PADDING;
    console.log(`[panel ${panel.index + 1}] Edge TTS → ${panel.tts_duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
    return duration;
  }

  // Priority 3: gTTS duration (from metadata)
  if (panel.tts_duration && panel.tts_provider === "gtts") {
    const duration = panel.tts_duration + PADDING;
    console.log(`[panel ${panel.index + 1}] gTTS → ${panel.tts_duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
    return duration;
  }

  // Priority 4: Narration text fallback
  if (panel.narration) {
    const wordCount = String(panel.narration).split(/\s+/).filter(Boolean).length;
    const duration = Math.max(3, Math.min(12, Math.round(wordCount / 2.3) + 1));
    console.log(`[panel ${panel.index + 1}] narration (${wordCount} words) → ${duration} sec`);
    return duration;
  }

  // Priority 5: Default
  console.log(`[panel ${panel.index + 1}] no audio/narration → default 4 sec`);
  return 4;
}

// ================================
// Validate Segment
// ================================

function validateSegment(segPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(segPath)) {
      return resolve({ valid: false, reason: "File does not exist" });
    }

    ffmpeg.ffprobe(segPath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const hasVideo = data.streams?.some(s => s.codec_type === "video");
      const hasAudio = data.streams?.some(s => s.codec_type === "audio");

      if (!hasVideo) {
        return resolve({ valid: false, reason: "No video stream found" });
      }

      if (!hasAudio) {
        return resolve({ valid: false, reason: "No audio stream found" });
      }

      resolve({ valid: true, data });
    });
  });
}

// ================================
// Multer - FIX #1: Use diskStorage instead of memoryStorage
// ================================

// FIX #1: Panel upload now uses diskStorage for better memory handling
const panelDiskStorage = multer.diskStorage({
  destination: UPLOADS_ROOT,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `panel_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  }
});

const panelUpload = multer({
  storage: panelDiskStorage,
  limits: { fileSize: 500 * 1024 * 1024, files: 4 }
});

const diskStorage = multer.diskStorage({
  destination: UPLOADS_ROOT,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  }
});

// FIX: Increased fileSize limit from 2MB to 300MB to support larger uploads
const diskUpload = multer({
  storage: diskStorage,
  limits: {
    fileSize: 300 * 1024 * 1024,  // 300MB per file (was 2MB)
    files: 3000                    // up to 3000 files
  }
});

// FIX #1: Audio ZIP upload now uses diskStorage instead of memoryStorage
const zipDiskStorage = multer.diskStorage({
  destination: TEMP_ROOT,
  filename: (_req, file, cb) => {
    cb(null, `audio_zip_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.zip`);
  }
});

const zipUpload = multer({
  storage: zipDiskStorage,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 }
});

// ================================
// FPS: Configurable (default 20) — cinematic anime/manhua feeling, much faster render
// ================================

function getFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) return 20;
  return Math.min(60, Math.max(1, Math.round(fps)));
}

// ================================
// ENHANCEMENT: Aspect Ratio Helper
// ================================

function calculateFitInFrame(imageAspectRatio, frameWidth = 1280, frameHeight = 720) {
  const frameAspect = frameWidth / frameHeight;
  
  let scaledWidth, scaledHeight;
  
  if (imageAspectRatio > frameAspect) {
    // Image is wider than frame
    scaledWidth = frameWidth;
    scaledHeight = Math.round(frameWidth / imageAspectRatio);
  } else {
    // Image is taller than frame
    scaledHeight = frameHeight;
    scaledWidth = Math.round(frameHeight * imageAspectRatio);
  }
  
  const offsetX = Math.round((frameWidth - scaledWidth) / 2);
  const offsetY = Math.round((frameHeight - scaledHeight) / 2);
  
  return { scaledWidth, scaledHeight, offsetX, offsetY };
}

// ================================
// Ken Burns Animation — cinematic zoom in/out + slide left/right/up/down
// 15fps · scale=2560 · zoom=1.18 · movement 10%–18% for alive anime feel
// ================================

function getKenBurnsFilter(idx, duration, panelCount = 1, aspectMode = "fit", width = 1280, height = 720, fps = 20, motion = "") {
  fps = getFps(fps);
  width = Math.max(2, Math.round(Number(width) || 1280));
  height = Math.max(2, Math.round(Number(height) || 720));
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const iw0 = width;
  const ih0 = height;
  const normalised = String(aspectMode || "fit").toLowerCase().trim();
  const requested = String(motion || "").toLowerCase().replace(/[_-]+/g, " ").trim();

  // Static is intentionally cheap: no zoompan.
  if (!requested || requested === "static") {
    if (normalised === "cinematic") {
      return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
    }
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  }

  const zIn = `scale=${iw0}:${ih0}:force_original_aspect_ratio=increase,crop=${iw0}:${ih0},zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps},setsar=1`;
  const zOut = `scale=${iw0}:${ih0}:force_original_aspect_ratio=increase,crop=${iw0}:${ih0},zoompan=z='if(lte(on,1),1.18,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps},setsar=1`;

  if (requested.includes("zoom out") || requested.includes("pull back")) return zOut;
  if (requested.includes("zoom in") || requested.includes("push in") || requested.includes("focus")) return zIn;

  const panBase = `scale=${iw0}:${ih0}:force_original_aspect_ratio=increase,crop=${iw0}:${ih0},zoompan=z='1.12':`;
  if (requested.includes("pan left") || requested.includes("slide left") || requested.includes("left")) {
    return `${panBase}x='if(lte(on,1),iw*0.10,min(x+iw*0.06/${totalFrames},iw*0.16))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps},setsar=1`;
  }
  if (requested.includes("pan right") || requested.includes("slide right") || requested.includes("right")) {
    return `${panBase}x='if(lte(on,1),iw*0.16,max(x-iw*0.06/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps},setsar=1`;
  }
  if (requested.includes("pan up") || requested.includes("slide up") || requested.includes("up")) {
    return `${panBase}x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.08,min(y+ih*0.06/${totalFrames},ih*0.14))':d=${totalFrames}:s=${width}x${height}:fps=${fps},setsar=1`;
  }
  if (requested.includes("pan down") || requested.includes("slide down") || requested.includes("down")) {
    return `${panBase}x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.14,max(y-ih*0.06/${totalFrames},ih*0.08))':d=${totalFrames}:s=${width}x${height}:fps=${fps},setsar=1`;
  }
  if (requested.includes("shake")) {
    return `scale=${iw0}:${ih0}:force_original_aspect_ratio=increase,crop=${iw0}:${ih0},zoompan=z='1.08':x='iw/2-(iw/zoom/2)+sin(on*1.7)*iw*0.006':y='ih/2-(ih/zoom/2)+cos(on*1.9)*ih*0.006':d=${totalFrames}:s=${width}x${height}:fps=${fps},setsar=1`;
  }

  // Unknown motion falls back to a deterministic zoom, never a costly random graph.
  return zIn;
}

// ================================
// ENHANCEMENT 1: Build FFmpeg audio filter chain with smooth normalization
// ================================

function buildAudioFilterChain(options = {}) {
  const filters = [];
  
  // Audio normalization for consistent loudness
  if (options.audioNormalize || options.loudnorm) {
    filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  }
  
  // Optional: Add gentle compression for smooth transitions
  if (options.smoothAudio) {
    filters.push("acompressor=threshold=0.05:ratio=4:attack=5:release=50");
  }
  
  return filters.length ? filters.join(",") : "";
}

// ================================
// ENHANCEMENT 2: Build FFmpeg video filter chain with quality optimization
// ================================

function buildVideoFilterChain(options = {}, baseFilter = "") {
  const filters = [baseFilter];
  
  // Optional zoom/crop adjustments (subtle, not aggressive)
  if (options.zoom || options.zoomFactor || options.cropX || options.cropY) {
    const zoomFactor = parseFloat(options.zoomFactor || options.zoom || 1.0);
    if (zoomFactor > 1.0 && zoomFactor <= 3.0) {
      const fx = Math.max(0, Math.min(1, parseFloat(options.focusX || 0.5)));
      const fy = Math.max(0, Math.min(1, parseFloat(options.focusY || 0.5)));
      const cw = Math.round(1280 / zoomFactor);
      const ch = Math.round(720  / zoomFactor);
      const cx = Math.round((1280 - cw) * fx);
      const cy = Math.round((720  - ch) * fy);
      filters.push(`crop=${cw}:${ch}:${cx}:${cy},scale=1280:720`);
    }
  }
  
  return filters.join(",");
}

// ================================
// Create Segment (MP4) - OPTIMIZED for quality & speed
// ================================


function parseOutputSettings(body = {}) {
  let width = Number(body.width || body.outputWidth || body.output_width);
  let height = Number(body.height || body.outputHeight || body.output_height);
  const resolution = String(body.resolution || body.outputResolution || body.output_resolution || "").toLowerCase().trim();
  if ((!width || !height) && resolution) {
    const m = resolution.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/);
    if (m) { width = Number(m[1]); height = Number(m[2]); }
    else if (resolution === "720p" || resolution === "hd") { width = 1280; height = 720; }
    else if (resolution === "1080p" || resolution === "fullhd" || resolution === "full-hd") { width = 1920; height = 1080; }
  }
  if (!width || !height) { width = 1280; height = 720; }

  // Railway-safe default/ceiling. The frontend may change FPS, but the
  // low-memory renderer must not accidentally receive a 1080p/4K request.
  // Set ALLOW_HIGHER_RESOLUTION=1 only on a machine with enough RAM.
  const allowHigher = String(process.env.ALLOW_HIGHER_RESOLUTION || "").toLowerCase() === "1" ||
                      String(process.env.ALLOW_HIGHER_RESOLUTION || "").toLowerCase() === "true";
  if (!allowHigher) {
    const scale = Math.min(1280 / width, 720 / height, 1);
    width = Math.max(2, Math.round(width * scale));
    height = Math.max(2, Math.round(height * scale));
    // Keep the requested aspect ratio while guaranteeing even dimensions.
    width -= width % 2;
    height -= height % 2;
  } else {
    width = Math.max(2, Math.min(3840, Math.round(width)));
    height = Math.max(2, Math.min(2160, Math.round(height)));
  }
  const fps = getFps(body.fps || body.frameRate || body.frame_rate || 20);
  return { width, height, fps };
}

function resolveAssetPath(value, projectDir) {
  if (!value) return null;
  const raw = typeof value === "string" ? value : (value.path || value.file || value.assetPath || value.asset_path);
  if (!raw) return null;
  const candidates = [
    raw,
    path.join(projectDir || "", raw),
    path.join(UPLOADS_ROOT, raw.replace(/^[/\\]+/, "")),
    path.join(TEMP_ROOT, raw.replace(/^[/\\]+/, ""))
  ];
  for (const candidate of candidates) {
    try {
      const abs = path.resolve(candidate);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch (_) {}
  }
  return null;
}

function normaliseAssetName(value) {
  return safeName(String(value || "").toLowerCase(), "");
}

function getPanelCinematic(panel, renderOptions, projectDir) {
  const c = panel.cinematic || panel.cinematicSettings || {};
  const vfxRaw = c.vfx ?? panel.vfx;
  const sfxRaw = c.sfx ?? panel.sfx;
  const motion = c.motion ?? panel.motion ?? panel.cameraMotion ?? renderOptions.motion ?? "";
  const vfxItems = [];
  const sfxItems = [];

  const addItem = (raw, collection) => {
    if (!raw || String(raw).trim().toLowerCase() === "none" || String(raw).trim().toLowerCase() === "off") return;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      if (typeof item === "string") collection.push({ name: item, path: null, opacity: 0.60, volume: 0.08 });
      else if (item && typeof item === "object" && item.enabled !== false) collection.push({
        name: item.name || item.id || "",
        path: resolveAssetPath(item.path || item.file || item.assetPath || item.asset_path, projectDir),
        opacity: Number(item.opacity ?? 0.60),
        volume: Number(item.volume ?? 0.08),
        start: Number(item.start ?? item.offset ?? 0),
        loop: item.loop !== false
      });
    }
  };
  addItem(vfxRaw, vfxItems);
  addItem(sfxRaw, sfxItems);

  // Range layers sent by the frontend can apply to this panel.
  const panelNumber = Number(panel.index || 0) + 1;
  for (const r of (renderOptions.vfxRanges || [])) {
    const from = Number(r.fromPanel ?? r.from ?? 1), to = Number(r.toPanel ?? r.to ?? 0);
    if (panelNumber >= from && panelNumber <= to) addItem(r.vfx || r.asset || r.name, vfxItems);
  }
  for (const r of (renderOptions.sfxRanges || [])) {
    const from = Number(r.fromPanel ?? r.from ?? 1), to = Number(r.toPanel ?? r.to ?? 0);
    if (panelNumber >= from && panelNumber <= to) addItem(r.sfx || r.asset || r.name, sfxItems);
  }

  // Resolve names through the library maps supplied by the frontend.
  const vfxLib = renderOptions.vfxLibrary || renderOptions.vfxAssets || {};
  const sfxLib = renderOptions.sfxLibrary || renderOptions.sfxAssets || {};
  for (const item of vfxItems) {
    if (!item.path && item.name) item.path = resolveAssetPath(vfxLib[item.name] || vfxLib[normaliseAssetName(item.name)], projectDir);
    item.opacity = Math.max(0, Math.min(1, Number.isFinite(item.opacity) ? item.opacity : 0.60));
  }
  for (const item of sfxItems) {
    if (!item.path && item.name) item.path = resolveAssetPath(sfxLib[item.name] || sfxLib[normaliseAssetName(item.name)], projectDir);
    item.volume = Math.max(0, Math.min(1, Number.isFinite(item.volume) ? item.volume : 0.08));
  }
  return { vfxItems, sfxItems, motion };
}

const VFX_CACHE_ROOT = path.join(TEMP_ROOT, "vfx-cache");
if (!fs.existsSync(VFX_CACHE_ROOT)) fs.mkdirSync(VFX_CACHE_ROOT, { recursive: true });

async function getMediaDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve(0);
      const d = Number(data?.format?.duration || data?.streams?.find(s => Number(s.duration) > 0)?.duration || 0);
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    });
  });
}

async function prepareVfxAsset(sourcePath, width, height, fps) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const stat = fs.statSync(sourcePath);
  const key = crypto.createHash("sha1")
    .update(`${path.resolve(sourcePath)}|${stat.size}|${stat.mtimeMs}|${width}x${height}|${fps}`)
    .digest("hex");
  const out = path.join(VFX_CACHE_ROOT, `${key}.webm`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

  const ext = path.extname(sourcePath).toLowerCase();
  const isImage = [".png",".jpg",".jpeg",".webp"].includes(ext);
  const duration = isImage ? 8 : await getMediaDuration(sourcePath);
  const safeDuration = Math.max(1, Math.min(60, duration || 8));

  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,fps=${fps}`;
  const args = ["-hide_banner","-loglevel","error","-y"];
  if (isImage) {
    args.push("-loop","1","-framerate",String(fps),"-i",sourcePath);
  } else {
    args.push("-stream_loop","-1","-i",sourcePath);
  }
  args.push("-vf",vf,"-t",String(safeDuration),"-an","-c:v","libvpx-vp9","-pix_fmt","yuva420p","-crf","32","-b:v","0",
           "-deadline","realtime","-cpu-used","5","-threads:v","2","-row-mt","0",out);
  await spawnFfmpeg(args, `prepare VFX ${path.basename(sourcePath)}`);
  return out;
}

function createSegment({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, renderOptions = {} }) {
  return new Promise(async (resolve, reject) => {
    try {
      const { width, height, fps } = parseOutputSettings(renderOptions);
      const cinematic = renderOptions.cinematic || {};
      const motion = cinematic.motion || renderOptions.motion || "";
      const baseFilter = getKenBurnsFilter(
        idx, duration, panelCount, aspectMode, width, height, fps, motion
      );

      const hasAudio = audioPath && fs.existsSync(audioPath);
      const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      console.log(`[${RENDERER_NAME}][seg${idx + 1}] START job=${jobId} ${width}x${height}@${fps} dur=${duration}s mem=${memMB}MB threads=2 filter_threads=1`);

      const cmd = ffmpeg()
        .setFfmpegPath(FFMPEG_PATH)
        .input(imagePath)
        .inputOptions(["-loop", "1", "-framerate", String(fps)]);

      if (hasAudio) cmd.input(audioPath);
      else {
        cmd.input(`anullsrc=channel_layout=stereo:sample_rate=48000`)
          .inputOptions(["-f","lavfi","-t",String(duration)]);
      }

      // Resolve requested VFX and SFX. Missing assets are a hard error; never silently skip them.
      const projectDir = renderOptions.projectDir || "";
      const preparedVfx = [];
      for (const item of (cinematic.vfxItems || [])) {
        const source = item.path;
        if (!source) throw new Error(`Panel ${idx + 1}: VFX asset not found: ${item.name || "unnamed"}`);
        const cached = await prepareVfxAsset(source, width, height, fps);
        if (!cached) throw new Error(`Panel ${idx + 1}: unable to prepare VFX: ${item.name || source}`);
        preparedVfx.push({ ...item, path: cached });
      }

      // Add prepared VFX inputs first. They are already normalized to target resolution/FPS.
      for (const item of preparedVfx) {
        cmd.input(item.path).inputOptions(["-stream_loop","-1"]);
      }

      // Add SFX inputs after VFX.
      const sfxInputs = [];
      for (const item of (cinematic.sfxItems || [])) {
        if (!item.path || !fs.existsSync(item.path)) {
          throw new Error(`Panel ${idx + 1}: SFX asset not found: ${item.name || "unnamed"}`);
        }
        cmd.input(item.path).inputOptions(["-stream_loop","-1"]);
        sfxInputs.push(item);
      }

      const vfxInputStart = 2;
      const sfxInputStart = 2 + preparedVfx.length;
      let complex = `[0:v]${baseFilter}[v0]`;
      let lastV = "[v0]";

      // Composite all VFX overlays at target resolution. Each source was normalized once and cached.
      for (let i = 0; i < preparedVfx.length; i++) {
        const item = preparedVfx[i];
        const inputIndex = vfxInputStart + i;
        const opacity = Math.max(0, Math.min(1, Number(item.opacity ?? 0.60)));
        const label = `[vfx${i}]`;
        complex += `;[${inputIndex}:v]format=rgba,colorchannelmixer=aa=${opacity}${label}`;
        complex += `;${lastV}${label}overlay=0:0:format=auto[v${i + 1}]`;
        lastV = `[v${i + 1}]`;
      }

      // SFX + narration audio mix.
      let audioMap = "1:a";
      if (sfxInputs.length) {
        const sfxLabels = [];
        for (let i = 0; i < sfxInputs.length; i++) {
          const inputIndex = sfxInputStart + i;
          const item = sfxInputs[i];
          const vol = Math.max(0, Math.min(1, Number(item.volume ?? 0.08)));
          const label = `[sfx${i}]`;
          complex += `;[${inputIndex}:a]atrim=0:${duration},asetpts=N/SR/TB,volume=${vol}${label}`;
          sfxLabels.push(label);
        }
        complex += `;[1:a]atrim=0:${duration},asetpts=N/SR/TB[voice];[voice]${sfxLabels.join("")}amix=inputs=${1 + sfxLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`;
        audioMap = "[aout]";
      } else {
        complex += `;[1:a]atrim=0:${duration},asetpts=N/SR/TB[aout]`;
        audioMap = "[aout]";
      }

      complex += `;${lastV}format=yuv420p[vout]`;

      const outputOpts = [
        "-filter_complex", complex,
        "-map", "[vout]",
        "-map", audioMap,
        "-c:v", renderOptions.videoCodec || "libx264",
        "-pix_fmt", renderOptions.pixFmt || "yuv420p",
        "-r", String(fps),
        "-g", String(Math.max(2, fps * 2)),
        "-crf", String(Math.max(18, Math.min(26, parseInt(renderOptions.crf,10) || 21))),
        "-preset", renderOptions.preset || "veryfast",
        // Explicit per-stream thread limits. Do not rely on FFmpeg's
        // automatic CPU detection on Railway.
        "-threads:v", "2",
        "-threads:a", "1",
        "-filter_threads", "1",
        "-filter_complex_threads", "1",
        "-x264-params", "threads=2:lookahead_threads=1",
        "-c:a", "aac",
        "-b:a", renderOptions.audioBitrate || "160k",
        "-t", String(duration),
        "-shortest",
        "-movflags", renderOptions.movflags || "+faststart",
        "-y"
      ];

      const proc = cmd.outputOptions(outputOpts).output(outPath);
      proc.on("start", command => console.log(`[${RENDERER_NAME}][seg${idx + 1}] ${command}`));
      proc.on("progress", p => {
        if (p.percent && Math.round(p.percent) % 25 === 0) {
          console.log(`[${RENDERER_NAME}][seg${idx + 1}] ${Math.round(p.percent)}%`);
        }
      });
      proc.on("end", () => {
        const endMem = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[${RENDERER_NAME}][seg${idx + 1}] END mem=${endMem}MB`);
        resolve();
      });
      proc.on("error", err => {
        const endMem = Math.round(process.memoryUsage().rss / 1024 / 1024);
        reject(new Error(`FFmpeg panel ${idx + 1} failed (mem=${endMem}MB): ${err.message}`));
      });
      proc.run();
    } catch (err) {
      reject(err);
    }
  });
}

// ================================
// createSegment with retry + skip on failure
// ================================

async function createSegmentSafe(opts) {
  let lastErr = null;
  const attempts = 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await createSegment(opts);
      return { success: true };
    } catch (err) {
      lastErr = err;
      console.error(`[seg${opts.idx + 1}] attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// ================================
// SPAWN FFmpeg Helper
// ================================

function spawnFfmpeg(args, description = "") {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] Running: ${FFMPEG_PATH} ${args.join(" ")}`);
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", data => {
      const chunk = data.toString();
      stderr = (stderr + chunk).slice(-12000);
      if (process.env.FFMPEG_LOG === "1") console.log(`[ffmpeg] ${chunk.trimEnd()}`);
    });
    proc.on("error", err => reject(new Error(`FFmpeg spawn failed: ${description}: ${err.message}`)));
    proc.on("close", (code, signal) => {
      if (code === 0) return resolve({ success: true, stderr });
      const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const reason = signal ? `signal=${signal}` : `exitCode=${code}`;
      reject(new Error(`FFmpeg ${description} failed (${reason}, memory=${memMB}MB). ${stderr.slice(-4000)}`));
    });
  });
}

// ================================
// CONCAT — Lossless stream-copy (no re-render, no quality loss, instant)
// Segments already encoded at the requested FPS/CRF; just join them.
// ================================

async function concatSegments(segPaths, durations, outPath, renderOptions = {}) {
  const n = segPaths.length;
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`\n[concat] START (stream-copy, no re-render) — ${n} segments — mem=${memMB}MB`);

  if (!n) throw new Error("No segments to concat");

  // Single segment: just copy
  if (n === 1) {
    console.log("[concat] Single segment — copying directly");
    fs.copyFileSync(segPaths[0], outPath);
    return;
  }

  // Verify all segments exist
  for (let i = 0; i < n; i++) {
    if (!fs.existsSync(segPaths[i])) {
      throw new Error(`Segment ${i} missing: ${segPaths[i]}`);
    }
  }

  // Write concat list file
  const concatFile = path.join(TEMP_ROOT, `concat_${Date.now()}.txt`);
  fs.writeFileSync(concatFile, segPaths.map(s => `file '${s}'`).join("\n"), "utf8");

  // Stream-copy concat — no decoding/re-encoding, zero quality loss, very fast
  const args = [
    "-f",      "concat",
    "-safe",   "0",
    "-i",      concatFile,
    "-c",      "copy",        // ← LOSSLESS: copy all streams, no re-render
    "-movflags", "+faststart",
    "-y",
    outPath
  ];

  console.log("[concat] Running lossless stream-copy concat...");
  try {
    await spawnFfmpeg(args, "lossless stream-copy concat");
    console.log(`[concat] ✓ stream-copy concat succeeded`);
  } finally {
    try { fs.unlinkSync(concatFile); } catch (_) {}
  }

  const memAfterMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[concat] END — mem=${memAfterMB}MB → ${outPath}`);
}

// ================================
// VALIDATION - Check all panels before render
// ================================

async function validateRenderPanels(panels) {
  const errors = [];

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const panelNum = i + 1;

    if (!p.image || !fs.existsSync(path.join(p.dir, p.image))) {
      errors.push(`Panel ${panelNum} image missing`);
      continue;
    }

    console.log(`[validate] ✓ Panel ${panelNum} image valid`);

    if (p.audio) {
      const audioPath = path.join(p.dir, p.audio);
      if (!fs.existsSync(audioPath)) {
        errors.push(`Panel ${panelNum} missing audio`);
        continue;
      }

      const result = await getAudioDuration(audioPath);
      if (!result.valid) {
        errors.push(`Panel ${panelNum} audio corrupted: ${result.reason}`);
        continue;
      }

      console.log(`[validate] ✓ Panel ${panelNum} audio valid (${result.duration.toFixed(1)} sec)`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Render validation failed:\n${errors.join("\n")}`);
  }

  console.log(`[validate] ✓ All ${panels.length} panels validated successfully`);
}

// ================================
// HEALTH CHECK
// ================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    renderer: RENDERER_NAME,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString()
  });
});

// ================================
// STATUS ROUTE
// ================================

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }
  res.json({ success: true, ...job });
});

// ================================
// PANEL UPLOAD ROUTE
// ================================

app.post(
  "/panel",
  panelUpload.fields([
    { name: "image", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  (req, res) => {
    try {
      const projectId = safeName(req.body.project_id || req.body.projectId, "project");
      const panelId   = safeName(req.body.panel_id || req.body.panelId || `panel_${Date.now()}`, "panel");
      const duration  = Number(req.body.duration || 4);
      const narration = String(req.body.narration || "").trim();

      if (!req.files?.image || !req.files.image[0]) {
        return res.status(400).json({ success: false, error: "Image required" });
      }

      const projectDir = path.join(UPLOADS_ROOT, projectId);
      const panelDir   = path.join(projectDir, panelId);

      [projectDir, panelDir].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      });

      // Keep uploads on disk; do not load large images into RAM.
      const imagePath = path.join(panelDir, `image${extFor(req.files.image[0], ".jpg")}`);
      fs.copyFileSync(req.files.image[0].path, imagePath);
      fs.unlinkSync(req.files.image[0].path);


      let audioPath = null;
      let audioFileName = null;
      if (req.files?.audio && req.files.audio[0]) {
        const audioExt = extFor(req.files.audio[0], ".mp3");
        audioFileName = `audio${audioExt}`;
        audioPath = path.join(panelDir, audioFileName);
        const audioBuffer = fs.readFileSync(req.files.audio[0].path);
        fs.writeFileSync(audioPath, audioBuffer);
        fs.unlinkSync(req.files.audio[0].path); // Clean up temp file
      }

      const index = Number(req.body.index || 0);
      const parseMaybeJson = (v) => {
        if (v == null || v === "") return null;
        try { return typeof v === "string" ? JSON.parse(v) : v; } catch (_) { return v; }
      };

      // Cinematic instructions can be stored with the panel and executed during render.
      const cinematic = parseMaybeJson(req.body.cinematic || req.body.cinematicSettings);
      const vfx = parseMaybeJson(req.body.vfx);
      const sfx = parseMaybeJson(req.body.sfx);
      const motion = req.body.motion || req.body.cameraMotion || null;

      // Per-panel manual zoom/crop (frontend sends 0-100 % focus or 0-1)
      const zoomVal = Math.max(1, Math.min(3, Number(req.body.zoom || req.body.zoomFactor || 1)));
      const rawFX = Number(req.body.focusX != null ? req.body.focusX : req.body.cropX);
      const rawFY = Number(req.body.focusY != null ? req.body.focusY : req.body.cropY);
      const focusX = Number.isFinite(rawFX) ? (rawFX > 1 ? rawFX / 100 : rawFX) : 0.5;
      const focusY = Number.isFinite(rawFY) ? (rawFY > 1 ? rawFY / 100 : rawFY) : 0.5;

      fs.writeFileSync(
        path.join(panelDir, "metadata.json"),
        JSON.stringify({
          index,
          duration,
          narration,
          image:       path.basename(imagePath),
          audio:       audioFileName,
          zoom:        zoomVal,
          focusX,
          focusY,
          cinematic,
          vfx,
          sfx,
          motion,
          uploaded_at: new Date().toISOString()
        }, null, 2)
      );

      console.log(`[panel] saved ${projectId}/${panelId}`);

      return res.json({
        success:    true,
        panel:      panelId,
        panel_id:   panelId,
        ref:        panelId,
        project_id: projectId
      });

    } catch (err) {
      console.error("/panel error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ================================
// AUDIO ZIP UPLOAD ROUTE
// ================================

app.post("/audio-zip", zipUpload.single("audioZip"), async (req, res) => {
  try {
    const projectId = safeName(req.body.project_id || req.body.projectId, "");
    if (!projectId) {
      return res.status(400).json({ success: false, error: "Missing project_id" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: "audioZip file required" });
    }

    const projectDir = path.join(UPLOADS_ROOT, projectId);
    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ success: false, error: "Project not found. Upload panels first." });
    }

    // Open ZIP directly from disk; do not load the entire archive into RAM.
    const zip = new AdmZip(req.file.path);
    fs.unlinkSync(req.file.path);
    
    const entries = zip.getEntries();

    const mp3Entries = entries
      .filter(e => !e.isDirectory)
      .filter(e => {
        const name = e.entryName.replace(/\\/g, "/");
        if (name.includes("__MACOSX")) return false;
        if (path.basename(name).startsWith(".")) return false;
        return /\.mp3$/i.test(name);
      })
      .map(e => {
        const base = path.basename(e.entryName);
        const match = base.match(/(\d+)/);
        return match ? { entry: e, num: Number(match[1]), file: base } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.num - b.num);

    if (!mp3Entries.length) {
      return res.status(400).json({
        success: false,
        error: "No valid numbered MP3 found. Use 1.mp3, 2.mp3, 3.mp3, audio_1.mp3, panel_1.mp3, etc."
      });
    }

    const panelFolders = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .map(name => {
        const dir = path.join(projectDir, name);
        const metaPath = path.join(dir, "metadata.json");
        if (!fs.existsSync(metaPath)) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        return { name, dir, metaPath, meta };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.meta.index || 0) - Number(b.meta.index || 0));

    const attached = [];
    const missing = [];

    for (let i = 0; i < panelFolders.length; i++) {
      const panelNumber = i + 1;
      const audio = mp3Entries.find(x => x.num === panelNumber);

      if (!audio) {
        missing.push(panelNumber);
        continue;
      }

      const panel = panelFolders[i];
      const outAudio = path.join(panel.dir, "audio.mp3");

      // Extract directly to disk instead of keeping the whole MP3 buffer
      // alive in Node memory.
      if (typeof zip.extractEntryTo === "function") {
        zip.extractEntryTo(audio.entry, panel.dir, false, true);
        const extracted = path.join(panel.dir, path.basename(audio.file));
        if (extracted !== outAudio) fs.renameSync(extracted, outAudio);
      } else {
        fs.writeFileSync(outAudio, audio.entry.getData());
      }

      panel.meta.audio = "audio.mp3";
      panel.meta.audio_source = "zip";
      panel.meta.audio_original = audio.file;

      fs.writeFileSync(panel.metaPath, JSON.stringify(panel.meta, null, 2));

      attached.push({
        panel: panelNumber,
        image: panel.meta.image,
        audio: audio.file,
        status: "attached"
      });
    }

    return res.json({
      success: true,
      project_id: projectId,
      totalPanels: panelFolders.length,
      totalMp3Found: mp3Entries.length,
      attached,
      missing,
      message: missing.length
        ? `Attached ${attached.length} audio files. Missing audio for panels: ${missing.join(", ")}`
        : `All ${attached.length} MP3 files attached successfully.`
    });

  } catch (err) {
    console.error("/audio-zip error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ================================
// CINEMATIC ASSET LIBRARY UPLOADS
// ================================

const LIBRARY_ROOT = path.join(UPLOADS_ROOT, "library");
const VFX_LIBRARY_ROOT = path.join(LIBRARY_ROOT, "vfx");
const SFX_LIBRARY_ROOT = path.join(LIBRARY_ROOT, "sfx");
[VFX_LIBRARY_ROOT, SFX_LIBRARY_ROOT].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const cinematicAssetUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, file, cb) => {
      const type = String(_req.body?.type || "").toLowerCase() === "sfx" ? SFX_LIBRARY_ROOT : VFX_LIBRARY_ROOT;
      cb(null, type);
    },
    filename: (_req, file, cb) => {
      const name = safeName(_req.body?.name || path.parse(file.originalname).name, "asset");
      const ext = path.extname(file.originalname).toLowerCase() || ".bin";
      cb(null, `${name}${ext}`);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 }
});

app.post("/library/asset", cinematicAssetUpload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "file required" });
    const type = String(req.body.type || "").toLowerCase() === "sfx" ? "sfx" : "vfx";
    const root = type === "sfx" ? SFX_LIBRARY_ROOT : VFX_LIBRARY_ROOT;
    const filePath = path.resolve(req.file.path);
    if (!filePath.startsWith(path.resolve(root) + path.sep)) {
      return res.status(400).json({ success: false, error: "invalid asset path" });
    }
    return res.json({
      success: true,
      type,
      name: path.parse(req.file.filename).name,
      path: filePath
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ================================
// RENDER ROUTE (async background job)
// ================================

// Multer for an optional overlay PNG attached to /render
const overlayUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_ROOT,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".png";
      cb(null, `overlay_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

function handleRender(req, res) {
  // If a "payload" JSON field was sent alongside multipart, merge it into req.body
  if (req.body && typeof req.body.payload === "string") {
    try {
      const parsed = JSON.parse(req.body.payload);
      for (const k of Object.keys(parsed)) {
        if (req.body[k] == null) req.body[k] = parsed[k];
      }
    } catch (_) {}
  }
  // Stash overlay file path on req (if uploaded)
  if (req.files) {
    const f = req.files.overlay?.[0] || req.files.overlayLogo?.[0] || req.files.watermark?.[0];
    if (f) req._overlayPath = f.path;
  }

  const hasProjectId = req.body?.project_id || req.body?.projectId;

  if (hasProjectId) {
    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });

    setImmediate(() => {
      enqueueRender(jobId, () => renderFromProject(req, jobId));
    });
    return;
  }

  // Images only — watermark/overlay removed for stability
  diskUpload.fields([
    { name: "images", maxCount: 2000 }
  ])(req, res, (multerErr) => {
    if (multerErr) {
      console.error("[/render] Multer error:", multerErr.message);
      return res.status(400).json({ success: false, error: multerErr.message });
    }

    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });

    setImmediate(() => {
      enqueueRender(jobId, () => renderFromMultipart(req, jobId));
    });
  });
}

// Accept /render as either:
//   - application/json                 -> handleRender directly
//   - multipart/form-data (overlay)    -> parse overlay+fields, then handleRender
app.post("/render", (req, res) => {
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("multipart/form-data")) {
    overlayUpload.fields([
      { name: "overlay",     maxCount: 1 },
      { name: "overlayLogo", maxCount: 1 },
      { name: "watermark",   maxCount: 1 }
    ])(req, res, (err) => {
      if (err) {
        console.error("[/render] overlay multer error:", err.message);
        return res.status(400).json({ success: false, error: err.message });
      }
      handleRender(req, res);
    });
  } else {
    handleRender(req, res);
  }
});

// ================================
// Extract render options from payload
// ================================

function extractRenderOptions(body) {
  // Map frontend outputFit -> backend aspectMode
  //   "cover"    -> "cinematic"  (fills frame; allows crop)
  //   "contain"  -> "fit"        (letterbox, full image visible)
  //   "blur-pad" -> "blurpad"    (blurred-scaled bg + full image overlay)
  let aspectMode = String(body.aspectMode || body.aspect_mode || "").toLowerCase();
  if (!aspectMode) {
    const fit = String(body.outputFit || body.output_fit || body.fit || "").toLowerCase();
    if (fit === "blur-pad" || String(body.padMode || body.pad_mode || "").toLowerCase() === "blur" || body.blurBackground === true || body.blur_background === true || body.blurBackground === "true" || body.blur_background === "true") {
      aspectMode = "blurpad";
    } else if (fit === "contain") aspectMode = "fit";
    else if (fit === "cover")    aspectMode = "cinematic";
    else aspectMode = "fit";
  }

  // Overlay/watermark metadata
  let overlay = null;
  try {
    const raw = body.overlay || body.overlayMeta;
    if (raw) overlay = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { overlay = null; }
  if (overlay && (overlay.enabled === false || overlay.enabled === "false")) overlay = null;

  const output = parseOutputSettings(body);
  let vfxRanges = [], sfxRanges = [];
  try { vfxRanges = typeof body.vfxRanges === "string" ? JSON.parse(body.vfxRanges) : (body.vfxRanges || []); } catch (_) {}
  try { sfxRanges = typeof body.sfxRanges === "string" ? JSON.parse(body.sfxRanges) : (body.sfxRanges || []); } catch (_) {}
  let vfxLibrary = {}, sfxLibrary = {};
  try { vfxLibrary = typeof body.vfxLibrary === "string" ? JSON.parse(body.vfxLibrary) : (body.vfxLibrary || {}); } catch (_) {}
  try { sfxLibrary = typeof body.sfxLibrary === "string" ? JSON.parse(body.sfxLibrary) : (body.sfxLibrary || {}); } catch (_) {}

  return {
    ...output,
    smoothAudio:   body.smoothAudio === true || body.smoothAudio === "true",
    crf:           body.crf || 21,
    preset:        body.preset || "faster",
    maxrate:       body.maxrate || "",
    bufsize:       body.bufsize || "",
    audioBitrate:  body.audioBitrate || "192k",
    movflags:      body.movflags || "+faststart",
    pixFmt:        body.pixFmt || "yuv420p",
    videoCodec:    body.videoCodec || "libx264",
    zoom:          body.zoom || null,
    zoomFactor:    body.zoomFactor || 1.0,
    cropX:         body.cropX || null,
    cropY:         body.cropY || null,
    focusX:        body.focusX || 0.5,
    focusY:        body.focusY || 0.5,
    aspectMode,
    overlay,
    vfxRanges,
    sfxRanges,
    vfxLibrary,
    sfxLibrary
  };
}

// ================================
// Render from uploaded panels (background)
// ================================

async function renderFromProject(req, jobId) {
  const projectId = safeName(req.body.project_id || req.body.projectId, "");

  if (!projectId) {
    return updateJob(jobId, { status: "error", error: "Missing project_id" });
  }

  const projectDir = path.join(UPLOADS_ROOT, projectId);

  if (!fs.existsSync(projectDir)) {
    return updateJob(jobId, {
      status: "error",
      error: `No uploaded panels found for project_id ${projectId}`
    });
  }

  let orderedRefs = [];
  try {
    if (Array.isArray(req.body.panels)) {
      orderedRefs = req.body.panels;
    } else if (typeof req.body.panels === "string") {
      orderedRefs = JSON.parse(req.body.panels);
    }
  } catch (_) {
    orderedRefs = [];
  }

  const readPanel = (panelId, fallbackIndex) => {
    const dir = path.join(
      projectDir,
      safeName(panelId, `panel_${fallbackIndex + 1}`)
    );
    const metaPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return { ...meta, dir, index: fallbackIndex };
  };

  let panels = [];

  if (orderedRefs.length) {
    panels = orderedRefs
      .map((ref, i) => {
        const panel = readPanel(ref.ref || ref.panel_id || ref.id || ref.panel, i);
        if (!panel) return null;
        if (ref && typeof ref === "object") {
          if (ref.cinematic != null) panel.cinematic = ref.cinematic;
          if (ref.vfx != null) panel.vfx = ref.vfx;
          if (ref.sfx != null) panel.sfx = ref.sfx;
          if (ref.motion != null) panel.motion = ref.motion;
          if (ref.cameraMotion != null) panel.cameraMotion = ref.cameraMotion;
        }
        return panel;
      })
      .filter(Boolean);
  } else {
    const folders = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    panels = folders.map((name, i) => readPanel(name, i)).filter(Boolean);
    panels.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }

  if (!panels.length) {
    return updateJob(jobId, { status: "error", error: "No complete panels found to render" });
  }

  updateJob(jobId, { status: "processing", progress: 0 });

  const batchIndex   = Number(req.body.batchIndex   || req.body.batch_index   || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);
  const panelCount   = panels.length;
  const renderOptions = extractRenderOptions(req.body);
  renderOptions.projectDir = projectDir;
  if (req._overlayPath && fs.existsSync(req._overlayPath)) {
    renderOptions.overlayPath = req._overlayPath;
  }

  updateJob(jobId, { batchIndex, totalBatches });

  const segPaths  = [];
  const durations = [];

  try {
    console.log(`[${RENDERER_NAME}][${jobId}] Starting validation — ${panels.length} panels`);
    await validateRenderPanels(panels);

    console.log(`[${RENDERER_NAME}][${jobId}] Starting render — ${panels.length} panels — batch ${batchIndex + 1}/${totalBatches} — panelCount=${panelCount}`);

    let skipped = 0;
    for (let i = 0; i < panels.length; i++) {
      const p   = panels[i];
      p.index = i;
      const dur = await calculatePanelDuration(p);
      const segPath = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);

      const cinematic = getPanelCinematic(p, renderOptions, projectDir);
      const perPanelOpts = {
        ...renderOptions,
        motion: cinematic.motion,
        cinematic,
        zoomFactor: Number(p.zoom || 1),
        focusX:     Number(p.focusX != null ? p.focusX : 0.5),
        focusY:     Number(p.focusY != null ? p.focusY : 0.5)
      };

      const result = await createSegmentSafe({
        imagePath: path.join(p.dir, p.image),
        audioPath: p.audio ? path.join(p.dir, p.audio) : null,
        text:      p.narration || "",
        duration:  dur,
        outPath:   segPath,
        jobId,
        idx: i,
        panelCount,
        aspectMode: renderOptions.aspectMode,
        renderOptions: perPanelOpts
      });

      segPaths.push(segPath);
      durations.push(dur);

      const pct = Math.round(((i + 1) / panels.length) * 80);
      updateJob(jobId, { progress: pct, skipped });
    }

    if (!segPaths.length) {
      throw new Error("All panels failed to render — no segments produced.");
    }
    if (skipped > 0) {
      console.warn(`[${jobId}] ⚠ ${skipped} panels were skipped due to errors`);
    }

    updateJob(jobId, { progress: 85 });

    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatSegments(segPaths, durations, finalPath, renderOptions);
    cleanupFiles(segPaths);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    setTimeout(() => {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }, 2 * 60 * 60 * 1000);

    updateJob(jobId, {
      status: "done",
      progress: 100,
      url,
      videoUrl: url,
      video_url: url,
      download_url: url,
      project_id: projectId,
      panels: panels.length,
      rendered: segPaths.length,
      skipped,
      batchIndex,
      totalBatches,
      renderer: RENDERER_NAME,
      format: "MP4 (H264 Video + AAC Audio)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)",
      fps: renderOptions.fps,

      aspectMode: renderOptions.aspectMode,
      resolution: `${renderOptions.width}x${renderOptions.height}`,
      encodingSettings: {
        crf: renderOptions.crf,
        preset: renderOptions.preset,
        concat: "stream-copy"
      }
    });

    scheduleJobEviction(jobId);
    console.log(`[${RENDERER_NAME}][${jobId}] Render complete → ${url}`);

  } catch (err) {
    console.error(`[${jobId}] Render ERROR:`, err.message);
    cleanupFiles(segPaths);
    updateJob(jobId, { status: "error", error: err.message });
    scheduleJobEviction(jobId);
  }
}

// ================================
// Render from multipart upload (background)
// ================================

async function renderFromMultipart(req, jobId) {
  const segPaths    = [];
  const durations   = [];
  
  // FIX: Use req.files.images array instead of req.files (because .fields() changes structure)
  const imageFiles = req.files.images || [];
  const uploadPaths = imageFiles.map((f) => f.path);

  if (!imageFiles?.length) {
    return updateJob(jobId, { status: "error", error: "No images uploaded." });
  }

  updateJob(jobId, { status: "processing", progress: 0 });

  const batchIndex   = Number(req.body.batchIndex   || req.body.batch_index   || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);
  const panelCount   = imageFiles.length;
  const renderOptions = extractRenderOptions(req.body);
  renderOptions.projectDir = path.dirname(imageFiles[0]?.path || UPLOADS_ROOT);

  updateJob(jobId, { batchIndex, totalBatches });

  try {
    const lines = String(req.body.narration || "")
      .split("\n")
      .map((l) => l.trim());

    while (lines.length < imageFiles.length) lines.push("");

    console.log(`[${RENDERER_NAME}][${jobId}] Starting multipart render — ${imageFiles.length} images — batch ${batchIndex + 1}/${totalBatches}`);

    let skipped = 0;
    for (let i = 0; i < imageFiles.length; i++) {
      const segPath  = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);
      const wordCount = String(lines[i] || "").split(/\s+/).filter(Boolean).length;
      const dur = Math.max(3, Math.min(12, Math.round(wordCount / 2.3) + 1));

      const result = await createSegmentSafe({
        imagePath: imageFiles[i].path,
        audioPath: null,
        text:      lines[i] || "",
        duration:  dur,
        outPath:   segPath,
        jobId,
        idx: i,
        panelCount,
        aspectMode: renderOptions.aspectMode,
        renderOptions
      });

      segPaths.push(segPath);
      durations.push(dur);

      const pct = Math.round(((i + 1) / imageFiles.length) * 80);
      updateJob(jobId, { progress: pct, skipped });
    }

    if (!segPaths.length) {
      throw new Error("All panels failed to render — no segments produced.");
    }
    if (skipped > 0) {
      console.warn(`[${jobId}] ⚠ ${skipped} panels were skipped due to errors`);
    }

    updateJob(jobId, { progress: 85 });

    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatSegments(segPaths, durations, finalPath, renderOptions);
    cleanupFiles([...segPaths, ...uploadPaths]);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    setTimeout(() => {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }, 2 * 60 * 60 * 1000);

    updateJob(jobId, {
      status: "done",
      progress: 100,
      url,
      videoUrl: url,
      video_url: url,
      download_url: url,
      panels: imageFiles.length,
      rendered: segPaths.length,
      skipped,
      batchIndex,
      totalBatches,
      renderer: RENDERER_NAME,
      format: "MP4 (H264 Video + AAC Audio)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)",
      fps: renderOptions.fps,

      aspectMode: renderOptions.aspectMode,
      resolution: `${renderOptions.width}x${renderOptions.height}`,
      encodingSettings: {
        crf: renderOptions.crf,
        preset: renderOptions.preset,
        concat: "stream-copy"
      }
    });

    scheduleJobEviction(jobId);
    console.log(`[${RENDERER_NAME}][${jobId}] Multipart render complete → ${url}`);

  } catch (err) {
    console.error(`[${jobId}] Multipart render ERROR:`, err.message);
    cleanupFiles([...segPaths, ...uploadPaths]);
    updateJob(jobId, { status: "error", error: err.message });
    scheduleJobEviction(jobId);
  }
}

// ================================
// 404
// ================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error:   "Route not found",
    path:    req.originalUrl
  });
});

// ================================
// Auto Cleanup (every 30 min)
// ================================

setInterval(() => {
  const now = Date.now();

  const removeOld = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (entry.isDirectory()) {
          removeOld(full);
          if (fs.readdirSync(full).length === 0 && now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
            fs.rmdirSync(full);
          }
        } else if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
          fs.unlinkSync(full);
          console.log(`[cleanup] Deleted old file: ${full}`);
        }
      } catch (_) {}
    }
  };
  removeOld(OUTPUT_ROOT);
  removeOld(TEMP_ROOT);
}, 30 * 60 * 1000);

// ================================
// START
// ================================

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`ScriptReel running on port ${PORT}`);
  console.log(`Renderer: ${RENDERER_NAME}`);
  console.log(`FFmpeg: ${FFMPEG_PATH}`);
  console.log(`Default render: 1280x720 @ 20fps; FFmpeg threads=${process.env.FFMPEG_THREADS || 2}`);
});

// FIX #4: Add Upload Timeout Safety
server.timeout = 0;
