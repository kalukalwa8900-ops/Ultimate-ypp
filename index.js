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

// ================================
// Middleware
// ================================

app.use(cors());

// FIX #2: Increase Request Limits
app.use(express.json({ limit: "2gb" }));
app.use(express.urlencoded({ extended: true, limit: "2gb" }));
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

[UPLOADS_ROOT, OUTPUT_ROOT, TEMP_ROOT, path.join(__dirname, "vfx-library"), path.join(__dirname, "sfx-library")].forEach((dir) => {
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
// Render constants — Railway Free safe defaults
// ================================
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const DEFAULT_FPS = 20;
const VIDEO_THREADS = 2;
const FILTER_THREADS = 1;
const DEFAULT_VFX_OPACITY = 0.60;
const DEFAULT_SFX_VOLUME = 0.08;

function getFps(_panelCount) {
  return DEFAULT_FPS;
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
// Ken Burns — 720p / 20 FPS / low-memory
// ================================
function getKenBurnsFilter(idx, duration, panelCount = 1, aspectMode = "fit", motion = "") {
  const fps = DEFAULT_FPS;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const normalised = String(aspectMode || "fit").toLowerCase().trim();
  const requested = String(motion || "").toLowerCase().trim();

  // Stable mapping so frontend can send simple words.
  let motionIndex = idx % 6;
  const map = {
    "static": -1, "none": -1,
    "zoom in": 0, "zoom_in": 0, "zoomin": 0,
    "zoom out": 1, "zoom_out": 1, "zoomout": 1,
    "slide left": 2, "slide_left": 2,
    "slide right": 3, "slide_right": 3,
    "slide up": 4, "slide_up": 4,
    "slide down": 5, "slide_down": 5
  };
  if (Object.prototype.hasOwnProperty.call(map, requested)) motionIndex = map[requested];
  if (motionIndex < 0) {
    return `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  }

  // Only ~1.25x working canvas instead of 2560px/4K intermediates.
  const workW = 1600;
  const fpsPart = `fps=${fps}`;
  const out = `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`;

  if (normalised === "blurpad" || normalised === "blur-pad" || normalised === "blur_pad") {
    // Keep blur-pad available, but use a modest blur to protect RAM.
    const base = `split[bg][fg];[bg]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},gblur=sigma=12[bg2]`;
    const fg = motionIndex === 0
      ? `[fg]scale=${workW}:-1,zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[fg2]`
      : motionIndex === 1
      ? `[fg]scale=${workW}:-1,zoompan=z='if(lte(on,1),1.12,max(zoom-0.0007,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[fg2]`
      : `[fg]scale=${workW}:-1,zoompan=z='1.10':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[fg2]`;
    return `${base};${fg};[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  }

  const animations = [
    `scale=${workW}:-1,zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    `scale=${workW}:-1,zoompan=z='if(lte(on,1),1.12,max(zoom-0.0007,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    `scale=${workW}:-1,zoompan=z='1.10':x='if(lte(on,1),iw*0.10,min(x+iw*0.06/${totalFrames},iw*0.16))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    `scale=${workW}:-1,zoompan=z='1.10':x='if(lte(on,1),iw*0.16,max(x-iw*0.06/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    `scale=${workW}:-1,zoompan=z='1.10':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.08,min(y+ih*0.06/${totalFrames},ih*0.14))':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    `scale=${workW}:-1,zoompan=z='1.10':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.14,max(y-ih*0.06/${totalFrames},ih*0.08))':d=${totalFrames}:s=${out}:fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
  ];
  return animations[motionIndex];
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
// VFX/SFX helpers
// ================================
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function resolveAssetPath(asset, kind = "vfx", projectDir = null) {
  if (!asset) return null;
  const raw = typeof asset === "string" ? asset : (asset.path || asset.file || asset.assetPath || asset.localPath || asset.name || "");
  if (!raw) return null;

  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(raw);
  else {
    if (projectDir) candidates.push(path.join(projectDir, raw));
    candidates.push(path.join(UPLOADS_ROOT, raw));
    candidates.push(path.join(__dirname, kind === "vfx" ? "vfx-library" : "sfx-library", raw));
    candidates.push(path.join(TEMP_ROOT, raw));
    candidates.push(raw);
  }
  return candidates.find(p => fs.existsSync(p)) || null;
}

function layerRange(layer) {
  const start = Number(layer.startPanel ?? layer.start ?? layer.from ?? layer.panelStart ?? layer.panel ?? 1);
  const end = Number(layer.endPanel ?? layer.end ?? layer.to ?? layer.panelEnd ?? start);
  return {
    start: Math.max(1, Math.floor(start || 1)),
    end: Math.max(1, Math.floor(end || start || 1))
  };
}

function activeLayers(layers, panelNumber) {
  return layers.filter(layer => {
    if (!layer || layer.enabled === false || layer.enabled === "false") return false;
    const r = layerRange(layer);
    return panelNumber >= r.start && panelNumber <= r.end;
  });
}

async function prepareVfxAsset(inputPath, fps = DEFAULT_FPS) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error(`VFX asset not found: ${inputPath || "empty"}`);
  }

  const stat = fs.statSync(inputPath);
  const key = crypto.createHash("sha1")
    .update(`${inputPath}|${stat.size}|${stat.mtimeMs}|${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}|${fps}`)
    .digest("hex");
  const cacheDir = path.join(__dirname, "vfx-library", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const outPath = path.join(cacheDir, `${key}.webm`);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;

  const ext = path.extname(inputPath).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
  const args = ["-hide_banner", "-loglevel", "error"];

  if (isImage) {
    args.push("-loop", "1", "-framerate", String(fps), "-i", inputPath, "-t", "5");
  } else {
    args.push("-i", inputPath);
  }

  args.push(
    "-vf", `fps=${fps},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=yuva420p`,
    "-an",
    "-c:v", "libvpx-vp9",
    "-b:v", "800k",
    "-deadline", "realtime",
    "-cpu-used", "5",
    "-auto-alt-ref", "0",
    "-threads", String(VIDEO_THREADS),
    "-y", outPath
  );

  console.log(`[vfx] preparing ${path.basename(inputPath)} → 720p/${fps}fps`);
  await spawnFfmpeg(args, `prepare VFX ${path.basename(inputPath)}`);
  return outPath;
}

// ================================
// Create Segment — 720p / 20 FPS / Ken Burns + optional VFX/SFX
// ================================
async function createSegment({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, motion: motionName, vfxLayers = [], sfxLayers = [], renderOptions = {} }) {
  const fps = DEFAULT_FPS;
  const panelNumber = idx + 1;

  // VFX is normalized once and reused from cache.
  const preparedVfx = [];
  for (const layer of vfxLayers) {
    const source = resolveAssetPath(layer, "vfx", renderOptions.projectDir);
    if (!source) throw new Error(`Panel ${panelNumber}: VFX asset not found: ${layer?.name || layer?.file || layer?.path || "unknown"}`);
    const prepared = await prepareVfxAsset(source, fps);
    preparedVfx.push({ layer, path: prepared });
  }

  const preparedSfx = [];
  for (const layer of sfxLayers) {
    const source = resolveAssetPath(layer, "sfx", renderOptions.projectDir);
    if (!source) throw new Error(`Panel ${panelNumber}: SFX asset not found: ${layer?.name || layer?.file || layer?.path || "unknown"}`);
    preparedSfx.push({ layer, path: source });
  }

  const motion = renderOptions.motion || motionName || "";
  const kenBurns = getKenBurnsFilter(idx, duration, panelCount, aspectMode, motion);
  const hasAudio = audioPath && fs.existsSync(audioPath);

  const cmd = ffmpeg()
    .setFfmpegPath(FFMPEG_PATH)
    .input(imagePath)
    .inputOptions(["-loop", "1", "-framerate", String(fps)]);

  if (hasAudio) {
    cmd.input(audioPath);
  } else {
    cmd.input(`aevalsrc=0:channel_layout=stereo:sample_rate=48000:duration=${duration}`)
      .inputOptions(["-f", "lavfi"]);
  }

  // Every VFX/SFX is a reusable range layer. The same asset can span many panels.
  for (const v of preparedVfx) {
    cmd.input(v.path).inputOptions(["-stream_loop", "-1"]);
  }
  for (const a of preparedSfx) {
    cmd.input(a.path).inputOptions(["-stream_loop", "-1"]);
  }

  const filter = [];
  filter.push(`[0:v]${kenBurns}[base]`);
  let current = "base";

  // VFX compositing. Opacity is applied per layer and defaults to 60%.
  preparedVfx.forEach((v, n) => {
    const inputIndex = 2 + n;
    const opacity = Math.max(0.05, Math.min(1, Number(v.layer.opacity ?? DEFAULT_VFX_OPACITY)));
    const label = `v${n}`;
    filter.push(`[${inputIndex}:v]fps=${fps},setpts=PTS-STARTPTS,format=rgba,colorchannelmixer=aa=${opacity}[${label}]`);
    filter.push(`[${current}][${label}]overlay=0:0:shortest=0:format=auto[ov${n}]`);
    current = `ov${n}`;
  });
  filter.push(`[${current}]format=yuv420p[outv]`);

  // SFX are mixed quietly under narration. Each active layer loops for the panel duration.
  const audioInputStart = 2 + preparedVfx.length;
  const audioLabels = ["[1:a]aresample=48000,asetpts=PTS-STARTPTS[narr]"];
  preparedSfx.forEach((a, n) => {
    const inputIndex = audioInputStart + n;
    const volume = Math.max(0, Math.min(0.08, Number(a.layer.volume ?? a.layer.gain ?? DEFAULT_SFX_VOLUME)));
    audioLabels.push(`[${inputIndex}:a]aresample=48000,asetpts=PTS-STARTPTS,volume=${volume.toFixed(4)},atrim=duration=${duration.toFixed(3)}[s${n}]`);
  });
  if (preparedSfx.length) {
    filter.push(...audioLabels);
    filter.push(`[narr]${preparedSfx.map((_, n) => `[s${n}]`).join("")}amix=inputs=${preparedSfx.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    filter.push("[1:a]aresample=48000,asetpts=PTS-STARTPTS[aout]");
  }

  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[${RENDERER_NAME}][seg${idx}] START panel=${panelNumber} dur=${duration.toFixed(2)}s VFX=${preparedVfx.length} SFX=${preparedSfx.length} mem=${memMB}MB`);

  const outputOpts = [
    "-filter_complex", filter.join(";"),
    "-map", "[outv]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-g", String(fps * 2),
    "-crf", "21",
    "-preset", "veryfast",
    "-threads", String(VIDEO_THREADS),
    "-filter_threads", String(FILTER_THREADS),
    "-filter_complex_threads", String(FILTER_THREADS),
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-t", String(duration),
    "-movflags", "+faststart",
    "-y"
  ];

  return new Promise((resolve, reject) => {
    cmd.outputOptions(outputOpts).output(outPath)
      .on("start", command => console.log(`[seg${idx}] ${command}`))
      .on("end", () => {
        const memAfter = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[${RENDERER_NAME}][seg${idx}] END mem=${memAfter}MB`);
        resolve();
      })
      .on("error", err => reject(new Error(`Panel ${panelNumber} FFmpeg failed: ${err.message}`)))
      .run();
  });
}

async function createSegmentSafe(opts) {
  // Do not silently skip panels. One failed panel must fail the job so the final
  // video never silently loses narration/images.
  await createSegment(opts);
  return { success: true };
}

// ================================
// SPAWN FFmpeg Helper
// ================================

function spawnFfmpeg(args, description = "") {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] Running: ffmpeg ${args.join(" ")}`);
    const proc = spawn(FFMPEG_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
      console.log(`[ffmpeg] stderr: ${data}`);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`[ffmpeg] ✓ ${description || "Command"} succeeded`);
        resolve({ success: true, stdout, stderr });
      } else {
        const isOOM = stderr.includes("Cannot allocate memory") ||
                      stderr.includes("Out of memory") ||
                      stderr.includes("ENOMEM") ||
                      code === 137;
        const label = isOOM ? "❌ OOM KILL" : "✗";
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const err = new Error(`FFmpeg ${isOOM ? "OOM" : `failed (code ${code})`}: ${description} — mem=${memMB}MB\n${stderr.slice(-800)}`);
        console.error(`[ffmpeg] ${label} ${description} code=${code} mem=${memMB}MB`);
        reject(err);
      }
    });

    proc.on("error", (err) => {
      console.error(`[ffmpeg] spawn error:`, err.message);
      reject(err);
    });
  });
}

// ================================
// CONCAT — Lossless stream-copy (no re-render, no quality loss, instant)
// Segments already encoded at 15fps/CRF-21; just join them.
// ================================

async function concatWithTransitions(segPaths, durations, outPath, renderOptions = {}) {
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
    queueLength: renderQueue.length,
    renderBusy,
    timestamp: new Date().toISOString()
  });
});


app.get("/render-config", (_req, res) => {
  res.json({
    success: true,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps: DEFAULT_FPS,
    videoThreads: VIDEO_THREADS,
    filterThreads: FILTER_THREADS,
    vfxOpacityDefault: DEFAULT_VFX_OPACITY,
    sfxVolumeDefault: DEFAULT_SFX_VOLUME,
    transitions: false
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

      // FIX #1: Read from disk instead of buffer
      const imageBuffer = fs.readFileSync(req.files.image[0].path);
      const imagePath = path.join(panelDir, `image.jpg`);
      fs.writeFileSync(imagePath, imageBuffer);
      fs.unlinkSync(req.files.image[0].path); // Clean up temp file

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
          image:       "image.jpg",
          audio:       audioFileName,
          zoom:        zoomVal,
          focusX,
          focusY,
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

    // FIX #1: Read from disk instead of memory buffer
    const zipBuffer = fs.readFileSync(req.file.path);
    const zip = new AdmZip(zipBuffer);
    fs.unlinkSync(req.file.path); // Clean up temp file
    
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

      fs.writeFileSync(outAudio, audio.entry.getData());

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
// Railway Free safety: one render job at a time
// ================================
const renderQueue = [];
let renderBusy = false;

function enqueueRender(fn) {
  renderQueue.push(fn);
  processRenderQueue();
}

async function processRenderQueue() {
  if (renderBusy || !renderQueue.length) return;
  renderBusy = true;
  const next = renderQueue.shift();
  try {
    await next();
  } catch (err) {
    console.error("[queue] render task failed:", err.message);
  } finally {
    renderBusy = false;
    setImmediate(processRenderQueue);
  }
}


// ================================
// VFX / SFX local libraries
// ================================
const vfxLibraryStorage = multer.diskStorage({
  destination: path.join(__dirname, "vfx-library"),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".webm";
    const base = safeName(path.basename(file.originalname, path.extname(file.originalname)), "vfx");
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});
const sfxLibraryStorage = multer.diskStorage({
  destination: path.join(__dirname, "sfx-library"),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".mp3";
    const base = safeName(path.basename(file.originalname, path.extname(file.originalname)), "sfx");
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});

const vfxLibraryUpload = multer({
  storage: vfxLibraryStorage,
  limits: { fileSize: 100 * 1024 * 1024, files: 1 }
});
const sfxLibraryUpload = multer({
  storage: sfxLibraryStorage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }
});

function listLibrary(dir, kind) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .filter(e => !e.name.startsWith("."))
    .filter(e => kind === "vfx"
      ? /\.(webm|mp4|mov|mkv|png|webp|jpg|jpeg)$/i.test(e.name)
      : /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(e.name))
    .map(e => ({
      name: e.name,
      path: path.join(dir, e.name),
      size: fs.statSync(path.join(dir, e.name)).size
    }));
}

app.get("/library/vfx", (_req, res) => {
  res.json({ success: true, items: listLibrary(path.join(__dirname, "vfx-library"), "vfx") });
});

app.get("/library/sfx", (_req, res) => {
  res.json({ success: true, items: listLibrary(path.join(__dirname, "sfx-library"), "sfx") });
});

app.post("/library/vfx", vfxLibraryUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "VFX file required" });
  res.json({ success: true, name: req.file.filename, path: req.file.path });
});

app.post("/library/sfx", sfxLibraryUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "SFX file required" });
  res.json({ success: true, name: req.file.filename, path: req.file.path });
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

    enqueueRender(async () => {
      await renderFromProject(req, jobId);
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

    enqueueRender(async () => {
      await renderFromMultipart(req, jobId);
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
  let aspectMode = String(body.aspectMode || body.aspect_mode || "").toLowerCase();
  if (!aspectMode) {
    const fit = String(body.outputFit || body.output_fit || body.fit || "").toLowerCase();
    if (fit === "blur-pad" || String(body.padMode || body.pad_mode || "").toLowerCase() === "blur" ||
        body.blurBackground === true || body.blur_background === true || body.blurBackground === "true" || body.blur_background === "true") {
      aspectMode = "blurpad";
    } else if (fit === "contain") aspectMode = "fit";
    else if (fit === "cover") aspectMode = "cinematic";
    else aspectMode = "fit";
  }

  let overlay = null;
  try {
    const raw = body.overlay || body.overlayMeta;
    if (raw) overlay = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { overlay = null; }
  if (overlay && (overlay.enabled === false || overlay.enabled === "false")) overlay = null;

  // Simple range-based cinematic layers. Frontend can send JSON or arrays.
  const vfxLayers = parseJsonArray(body.vfxLayers || body.vfx_layers || body.vfx);
  const sfxLayers = parseJsonArray(body.sfxLayers || body.sfx_layers || body.sfx);

  return {
    smoothAudio: false,
    crf: 21,
    preset: "veryfast",
    maxrate: "",
    bufsize: "",
    audioBitrate: "128k",
    movflags: "+faststart",
    pixFmt: "yuv420p",
    videoCodec: "libx264",
    zoom: null,
    zoomFactor: 1.0,
    cropX: null,
    cropY: null,
    focusX: 0.5,
    focusY: 0.5,
    aspectMode,
    overlay,
    motion: body.motion || "",
    vfxLayers,
    sfxLayers,
    projectDir: null
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
      .map((p, i) => readPanel(p.ref || p.panel_id || p.id || p.panel, i))
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

    // Pre-normalize every global VFX asset once before panel rendering.
    // The normalized 720p/20fps asset is cached and reused for all matching ranges.
    const uniqueVfx = new Map();
    for (const layer of renderOptions.vfxLayers || []) {
      const source = resolveAssetPath(layer, "vfx", projectDir);
      if (!source) throw new Error(`VFX asset not found: ${layer?.name || layer?.file || layer?.path || "unknown"}`);
      uniqueVfx.set(source, layer);
    }
    for (const source of uniqueVfx.keys()) {
      await prepareVfxAsset(source, DEFAULT_FPS);
    }

    console.log(`[${RENDERER_NAME}][${jobId}] Starting render — ${panels.length} panels — batch ${batchIndex + 1}/${totalBatches} — panelCount=${panelCount}`);

    let skipped = 0;
    for (let i = 0; i < panels.length; i++) {
      const p   = panels[i];
      p.index = i;
      const dur = await calculatePanelDuration(p);
      const segPath = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);

      const perPanelOpts = {
        ...renderOptions,
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
        motion: p.motion || p.cameraMotion || perPanelOpts.motion || "",
        vfxLayers: [
          ...activeLayers(renderOptions.vfxLayers || [], i + 1),
          ...parseJsonArray(p.vfxLayers || p.vfx_layers || p.vfx).map(v => typeof v === "string" ? { name: v, file: v, startPanel: i + 1, endPanel: i + 1 } : v)
        ],
        sfxLayers: [
          ...activeLayers(renderOptions.sfxLayers || [], i + 1),
          ...parseJsonArray(p.sfxLayers || p.sfx_layers || p.sfx).map(v => typeof v === "string" ? { name: v, file: v, startPanel: i + 1, endPanel: i + 1 } : v)
        ],
        renderOptions: perPanelOpts
      });

      if (result.success) {
        segPaths.push(segPath);
        durations.push(dur);
      } else {
        skipped++;
        console.warn(`[${jobId}] Panel ${i + 1} skipped (${skipped} total skipped)`);
      }

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
    await concatWithTransitions(segPaths, durations, finalPath, renderOptions);
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
      fps: DEFAULT_FPS,
      aspectMode: renderOptions.aspectMode,
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

      if (result.success) {
        segPaths.push(segPath);
        durations.push(dur);
      } else {
        skipped++;
        console.warn(`[${jobId}] Panel ${i + 1} skipped (${skipped} total skipped)`);
      }

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
    await concatWithTransitions(segPaths, durations, finalPath, renderOptions);
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
      fps: DEFAULT_FPS,
      aspectMode: renderOptions.aspectMode,
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

  [OUTPUT_ROOT, TEMP_ROOT].forEach((dir) => {
    try {
      fs.readdirSync(dir).forEach((file) => {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
            fs.unlinkSync(full);
            console.log(`[cleanup] Deleted old file: ${file}`);
          }
        } catch (_) {}
      });
    } catch (_) {}
  });
}, 30 * 60 * 1000);

// ================================
// START
// ================================

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`ScriptReel running on port ${PORT}`);
  console.log(`Renderer: ${RENDERER_NAME}`);
  console.log(`FFmpeg: ${FFMPEG_PATH}`);
});

// FIX #4: Add Upload Timeout Safety
server.timeout = 0;
