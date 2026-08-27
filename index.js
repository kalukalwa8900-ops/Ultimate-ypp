const express = require("express");
const multer = require("multer");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const AdmZip = require("adm-zip");
const {
  loadConfig: loadMotionConfig,
  MOTION_MAP,
  TRANSITION_MAP,
  coerceMotion,
  coerceTransition,
  getMotionFilter,
  getTransitionRecipe,
  escFilterArg,
  escFilterPath
} = require("./cinematic");

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

[UPLOADS_ROOT, OUTPUT_ROOT, TEMP_ROOT].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Cinematic asset library — cached by semantic name, idempotent uploads
const ASSETS_ROOT     = path.join(__dirname, "assets");
const ASSETS_VFX_ROOT = path.join(ASSETS_ROOT, "vfx");
const ASSETS_SFX_ROOT = path.join(ASSETS_ROOT, "sfx");

[ASSETS_ROOT, ASSETS_VFX_ROOT, ASSETS_SFX_ROOT].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function findAsset(kind, name) {
  const root = kind === "vfx" ? ASSETS_VFX_ROOT : ASSETS_SFX_ROOT;
  const cleanName = safeName(name, "");
  if (!cleanName) return null;
  try {
    const files = fs.readdirSync(root);
    const hit = files.find(f => path.basename(f, path.extname(f)) === cleanName);
    return hit ? path.join(root, hit) : null;
  } catch (_) {
    return null;
  }
}

function listAssets(kind) {
  const root = kind === "vfx" ? ASSETS_VFX_ROOT : ASSETS_SFX_ROOT;
  try {
    return fs.readdirSync(root).map((f) => ({
      name: path.basename(f, path.extname(f)),
      file: f,
      kind
    }));
  } catch (_) {
    return [];
  }
}

// ================================
// FFmpeg concurrency queue — caps simultaneous ffmpeg spawns
// ================================

const MAX_CONCURRENT_FFMPEG = Number(process.env.MAX_CONCURRENT_FFMPEG || 3);
let activeFfmpegCount = 0;
const ffmpegQueue = [];

function runQueuedFfmpeg(task) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (activeFfmpegCount >= MAX_CONCURRENT_FFMPEG) {
        ffmpegQueue.push(attempt);
        return;
      }
      activeFfmpegCount++;
      task().then((v) => {
        activeFfmpegCount--;
        drainFfmpegQueue();
        resolve(v);
      }).catch((err) => {
        activeFfmpegCount--;
        drainFfmpegQueue();
        reject(err);
      });
    };
    attempt();
  });
}

function drainFfmpegQueue() {
  if (activeFfmpegCount < MAX_CONCURRENT_FFMPEG && ffmpegQueue.length) {
    const next = ffmpegQueue.shift();
    next();
  }
}

// ================================
// Job store cap — evict oldest jobs beyond a soft cap
// ================================

const MAX_TRACKED_JOBS = Number(process.env.MAX_TRACKED_JOBS || 500);

function evictOldestJobsIfNeeded() {
  const ids = Object.keys(jobs);
  if (ids.length <= MAX_TRACKED_JOBS) return;
  const sorted = ids.sort((a, b) => new Date(jobs[a].createdAt) - new Date(jobs[b].createdAt));
  const toEvict = sorted.slice(0, ids.length - MAX_TRACKED_JOBS);
  toEvict.forEach((id) => { delete jobs[id]; });
}

// ================================
// In-Memory Job Store
// ================================

const jobs = {};

function createJob() {
  evictOldestJobsIfNeeded();
  const jobId = crypto.randomBytes(8).toString("hex");
  jobs[jobId] = {
    status: "queued",
    progress: 0,
    url: null,
    error: null,
    warnings: [],
    createdAt: new Date()
  };
  return jobId;
}

function addJobWarning(jobId, message) {
  if (!jobs[jobId]) return;
  if (!Array.isArray(jobs[jobId].warnings)) jobs[jobId].warnings = [];
  jobs[jobId].warnings.push(message);
  console.warn(`[job ${jobId}] warning: ${message}`);
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
  const PADDING = 0.2;

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
// FPS: Fixed at 15 — cinematic anime/manhua feeling, much faster render
// ================================

function getFps(panelCount) {
  // 15fps: more visible motion per frame, anime/manhua style, ~40% faster encode
  return 15;
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

function getKenBurnsFilter(idx, duration, panelCount = 1, aspectMode = "fit") {
  const fps = 15; // Always 15fps
  const totalFrames = Math.ceil(duration * fps);
  const normalised = String(aspectMode || "fit").toLowerCase().trim();

  if (normalised === "fit") {
    // FIT MODE — full image visible, letterbox/pillarbox, strong Ken Burns
    const animations = [
      // 1. Zoom IN (100% → 118%)
      `scale=2560:-1,zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 2. Zoom OUT (118% → 100%)
      `scale=2560:-1,zoompan=z='if(lte(on,1),1.18,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 3. Slide LEFT (pan 10% → 18%)
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.10,min(x+iw*0.08/${totalFrames},iw*0.18))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 4. Slide RIGHT (pan 18% → 10%)
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.18,max(x-iw*0.08/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 5. Slide UP (pan 8% → 16% vertical)
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.08,min(y+ih*0.08/${totalFrames},ih*0.16))':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 6. Slide DOWN (pan 16% → 8% vertical)
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.16,max(y-ih*0.08/${totalFrames},ih*0.08))':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    ];
    return animations[idx % animations.length];

  } else if (normalised === "cinematic") {
    // CINEMATIC MODE — fill full frame, stronger zoom and movement
    const animations = [
      // 1. Zoom IN center
      `scale=2560:-1,zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 2. Zoom OUT center
      `scale=2560:-1,zoompan=z='if(lte(on,1),1.18,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 3. Slide LEFT
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.10,min(x+iw*0.08/${totalFrames},iw*0.18))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 4. Slide RIGHT
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.18,max(x-iw*0.08/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 5. Slide UP
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.08,min(y+ih*0.08/${totalFrames},ih*0.16))':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 6. Slide DOWN
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.16,max(y-ih*0.08/${totalFrames},ih*0.08))':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
    ];
    return animations[idx % animations.length];
  }

  if (normalised === "blurpad" || normalised === "blur-pad" || normalised === "blur_pad") {
    // BLUR-PAD MODE — original image centred at native ratio over a heavily
    // blurred, scaled copy of itself. No distortion, no black bars.
    // Ken Burns is applied to the foreground only; the blurred bg is static.
    const animations = [
      // 1. Zoom IN foreground
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
      // 2. Zoom OUT foreground
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='if(lte(on,1),1.18,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
      // 3. Slide LEFT
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='1.12':x='if(lte(on,1),iw*0.10,min(x+iw*0.06/${totalFrames},iw*0.16))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
      // 4. Slide RIGHT
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='1.12':x='if(lte(on,1),iw*0.16,max(x-iw*0.06/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
    ];
    return animations[idx % animations.length];
  }

  // Default: static fit (fastest, no animation)
  return `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
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

function createSegment(opts) {
  return runQueuedFfmpeg(() => createSegmentRun(opts));
}

function createSegmentRun({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, renderOptions = {} }) {
  return new Promise((resolve, reject) => {
    const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const wrapped = wrapText(text);

    // v2.5 — motion keyword drives the Ken Burns filter. Falls back to the
    // legacy index-cycling behaviour when no keyword is supplied.
    const motionCfg = loadMotionConfig();
    const motionKeyword = renderOptions.motion;
    const kenBurns = motionKeyword
      ? getMotionFilter(motionKeyword, 1280, 720, duration, 15, motionCfg)
      : getKenBurnsFilter(idx, duration, panelCount, aspectMode);

    const vfParts = [
      buildVideoFilterChain(renderOptions, kenBurns),
      "setsar=1"
    ];

    const hasAudio = audioPath && fs.existsSync(audioPath);
    const overlayPath = renderOptions.overlayPath && fs.existsSync(renderOptions.overlayPath)
      ? renderOptions.overlayPath : null;
    const overlayMeta = renderOptions.overlay || null;

    // v2.5 — Optional VFX overlay (looped/trimmed to panel duration, delayed
    // for EVENT mode, alpha-composited or screen-blended onto the frame).
    const vfxPath = renderOptions.vfxPath && fs.existsSync(renderOptions.vfxPath)
      ? renderOptions.vfxPath : null;
    const vfxMeta = renderOptions.vfxMeta || null;

    // v2.5 — Optional SFX list to mix under the narration for this panel.
    const sfxList = Array.isArray(renderOptions.sfxList)
      ? renderOptions.sfxList.filter(s => s && s.path && fs.existsSync(s.path))
      : [];

    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[${RENDERER_NAME}][seg${idx}] START — jobId=${jobId} mode=${aspectMode} dur=${duration}s panelCount=${panelCount} mem=${memMB}MB`);

    const cmd = ffmpeg()
      .setFfmpegPath(FFMPEG_PATH)
      .input(imagePath)
      .inputOptions(["-loop 1", "-framerate 15"]);

    if (hasAudio) {
      cmd.input(audioPath);
    } else {
      cmd
        .input(`aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${duration}`)
        .inputOptions(["-f lavfi"]);
    }

    // Optional channel branding overlay (PNG with alpha)
    if (overlayPath) {
      cmd.input(overlayPath);
    }

    // v2.5 — VFX overlay input (looped so it can be trimmed to any duration)
    let vfxInputIdx = null;
    if (vfxPath) {
      cmd.input(vfxPath).inputOptions(["-stream_loop -1"]);
      vfxInputIdx = overlayPath ? 3 : 2;
    }

    // v2.5 — SFX inputs, one per cue
    const sfxInputIndices = [];
    if (sfxList.length) {
      let base = 2;
      if (overlayPath) base += 1;
      if (vfxPath) base += 1;
      sfxList.forEach((s, i) => {
        cmd.input(s.path);
        sfxInputIndices.push(base + i);
      });
    }

    // Speed-optimised quality settings
    const videoCodec   = renderOptions.videoCodec  || "libx264";
    const pixFmt       = renderOptions.pixFmt       || "yuv420p";
    const crf          = Math.max(18, Math.min(26, parseInt(renderOptions.crf) || 21)); // CRF 21
    const preset       = renderOptions.preset        || "faster"; // faster > medium for speed
    const maxrate      = renderOptions.maxrate        || "";
    const bufsize      = renderOptions.bufsize        || "";
    const audioBitrate = renderOptions.audioBitrate   || "192k";
    const movflags     = renderOptions.movflags ? String(renderOptions.movflags) : "+faststart";

    // No loudnorm — removed for speed; audio passed through clean
    // Build the video filter pipeline. If an overlay/VFX/SFX is attached,
    // switch from -vf to -filter_complex so we can composite/mix them.
    let videoFilterFlag = ["-vf", vfParts.join(",")];
    const needsComplex = overlayPath || vfxPath || sfxList.length;

    if (needsComplex) {
      let videoChain = `[0:v]${vfParts.join(",")}[bgv]`;
      let lastVideoLabel = "bgv";
      const complexParts = [videoChain];

      if (overlayPath) {
        const pos = overlayMeta?.position || "top-right";
        const sizePct = Math.max(3, Math.min(40, Number(overlayMeta?.sizePct ?? 12)));
        const margin  = Math.max(0, Math.min(200, Number(overlayMeta?.marginPx ?? 16)));
        const opacity = Math.max(0.05, Math.min(1, Number(overlayMeta?.opacity ?? 1)));
        const wmW = Math.round(1280 * sizePct / 100);

        let xExpr, yExpr;
        if (pos === "top-left")          { xExpr = String(margin);    yExpr = String(margin); }
        else if (pos === "bottom-left")  { xExpr = String(margin);    yExpr = `H-h-${margin}`; }
        else if (pos === "bottom-right") { xExpr = `W-w-${margin}`;   yExpr = `H-h-${margin}`; }
        else                              { xExpr = `W-w-${margin}`;   yExpr = String(margin); }

        complexParts.push(`[2:v]scale=${wmW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm]`);
        complexParts.push(`[${lastVideoLabel}][wm]overlay=${xExpr}:${yExpr}:format=auto[bgv2]`);
        lastVideoLabel = "bgv2";
      }

      if (vfxPath && vfxInputIdx != null) {
        const mode    = String(vfxMeta?.mode || "EVENT").toUpperCase();
        const offset  = Math.max(0, Number(vfxMeta?.offset || 0));
        const opacity = Math.max(0.05, Math.min(1, Number(vfxMeta?.opacity ?? 0.5)));
        const delayMs = mode === "EVENT" ? Math.round(offset * 1000) : 0;
        // Trim/scale VFX clip to frame, apply alpha, delay for EVENT mode.
        const vfxChain =
          `[${vfxInputIdx}:v]trim=duration=${duration},setpts=PTS-STARTPTS,` +
          `scale=1280:720,format=rgba,colorchannelmixer=aa=${opacity}` +
          (delayMs > 0 ? `,tpad=start_duration=${(delayMs / 1000).toFixed(3)}:color=black@0.0` : "") +
          `[vfx]`;
        complexParts.push(vfxChain);
        complexParts.push(`[${lastVideoLabel}][vfx]overlay=0:0:format=auto:shortest=1[bgv3]`);
        lastVideoLabel = "bgv3";
      }

      complexParts.push(`[${lastVideoLabel}]null[outv]`);

      // Audio: mix narration (or silence) with any SFX cues, each delayed to its offset.
      const narrationLabel = "1:a";
      let audioComplex;
      if (sfxList.length) {
        const sfxLabels = [];
        sfxList.forEach((s, i) => {
          const inputIdx = sfxInputIndices[i];
          const delayMs = Math.max(0, Math.round((s.offset || 0) * 1000));
          const vol = Math.max(0, Math.min(4, Number(s.volume || 1)));
          const label = `sfx${i}`;
          complexParts.push(`[${inputIdx}:a]atrim=duration=${duration},adelay=${delayMs}|${delayMs},volume=${vol}[${label}]`);
          sfxLabels.push(`[${label}]`);
        });
        audioComplex = `[${narrationLabel}]${sfxLabels.join("")}amix=inputs=${sfxLabels.length + 1}:duration=first:dropout_transition=0[outa]`;
      } else {
        audioComplex = `[${narrationLabel}]anull[outa]`;
      }
      complexParts.push(audioComplex);

      videoFilterFlag = ["-filter_complex", complexParts.join(";"), "-map", "[outv]", "-map", "[outa]"];
    }

    const outputOpts = [
      ...videoFilterFlag,
      `-c:v ${videoCodec}`,
      `-pix_fmt ${pixFmt}`,
      `-r 15`,           // ← 15 fps output
      `-g 30`,           // ← GOP = 2× fps for clean seeking
      `-crf ${crf}`,
      `-preset ${preset}`,
      `-threads 0`,      // ← Let FFmpeg use all available CPU cores
      `-movflags ${movflags}`,
      `-c:a aac`,
      `-b:a ${audioBitrate}`,
      "-shortest",
      `-t ${duration}`
    ];

    // Add bitrate control if specified
    if (maxrate) outputOpts.splice(-3, 0, `-maxrate ${maxrate}`);
    if (bufsize)  outputOpts.splice(-3, 0, `-bufsize ${bufsize}`);

    cmd
      .outputOptions(outputOpts)
      .output(outPath)
      .on("start", () => {
        console.log(`[seg${idx}] FFmpeg encoding started`);
      })
      .on("progress", () => {
        // suppress per-frame logs
      })
      .on("end", () => {
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[seg${idx}] END — mem=${memMB}MB`);
        resolve();
      })
      .on("error", (err) => {
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const isOOM = err.message.includes("Cannot allocate memory") ||
                      err.message.includes("Out of memory") ||
                      err.message.includes("ENOMEM") ||
                      err.message.includes("killed");
        if (isOOM) {
          console.error(`[seg${idx}] ❌ OOM CRASH — mem=${memMB}MB — ${err.message}`);
        } else {
          console.error(`[seg${idx}] ❌ ERROR — mem=${memMB}MB — ${err.message}`);
        }
        reject(err);
      })
      .run();
  });
}

// ================================
// createSegment with retry + skip on failure
// ================================

async function createSegmentSafe({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, renderOptions = {} }) {
  const MAX_RETRIES = 2;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await createSegment({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, renderOptions });
      return { success: true };
    } catch (err) {
      lastErr = err;
      const isOOM = err.message.includes("Cannot allocate memory") ||
                    err.message.includes("Out of memory") ||
                    err.message.includes("ENOMEM") ||
                    err.message.includes("killed");
      console.warn(`[seg${idx}] attempt ${attempt}/${MAX_RETRIES} failed${isOOM ? " (OOM)" : ""}: ${err.message.split("\n")[0]}`);
      if (isOOM) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
  }

  console.error(`[seg${idx}] ❌ ALL RETRIES FAILED — skipping panel. Last error: ${lastErr.message.split("\n")[0]}`);
  return { success: false, error: lastErr.message };
}

// ================================
// SPAWN FFmpeg Helper
// ================================

function spawnFfmpegRaw(args, description = "") {
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

// Public entrypoint — caps concurrent ffmpeg processes via a small queue
function spawnFfmpeg(args, description = "") {
  return runQueuedFfmpeg(() => spawnFfmpegRaw(args, description));
}

// ================================
// CONCAT — Lossless stream-copy (no re-render, no quality loss, instant)
// Segments already encoded at 15fps/CRF-21; just join them.
// ================================

async function concatWithTransitions(segPaths, durations, outPath, renderOptions = {}) {
  const n = segPaths.length;
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // v2.5 — per-panel transition keyword (applies BETWEEN segment i and i+1).
  const transitions = (renderOptions.transitions || []).map(t => coerceTransition(t));
  const hasCinematicTransitions = transitions.some(t => t && t !== "Hard Cut");

  if (!hasCinematicTransitions) {
    console.log(`\n[concat] START (stream-copy, no re-render) — ${n} segments — mem=${memMB}MB`);
  } else {
    console.log(`\n[concat] START (xfade re-encode, cinematic transitions) — ${n} segments — mem=${memMB}MB`);
  }

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

  if (!hasCinematicTransitions) {
    console.log("[concat] Running lossless stream-copy concat...");
    try {
      await spawnFfmpeg(args, "lossless stream-copy concat");
      console.log(`[concat] ✓ stream-copy concat succeeded`);
    } finally {
      try { fs.unlinkSync(concatFile); } catch (_) {}
    }
  } else {
    try { fs.unlinkSync(concatFile); } catch (_) {}
    const cfg = loadMotionConfig();
    // Build an xfade/fade chain across all segments, re-encoding once.
    // Falls back segment-by-segment: Hard Cut = plain concat point (offset 0 overlap),
    // everything else = an xfade of the recipe's type/duration at that boundary.
    const inputArgs = [];
    segPaths.forEach(p => { inputArgs.push("-i", p); });

    let filter = "";
    let vLabel = "0:v";
    let aLabel = "0:a";
    let cumulative = durations[0];

    for (let i = 1; i < n; i++) {
      const recipe = getTransitionRecipe(transitions[i - 1] || "Hard Cut", cfg);
      const dur = Math.max(0, Math.min(recipe.duration || 0, durations[i - 1] - 0.05, durations[i] - 0.05));
      const outV = `v${i}`;
      const outA = `a${i}`;
      const offset = Math.max(0, cumulative - dur);

      if (!dur || recipe.type === "hardcut") {
        filter += `[${vLabel}][${i}:v]concat=n=2:v=1:a=0[${outV}];`;
        filter += `[${aLabel}][${i}:a]concat=n=2:v=0:a=1[${outA}];`;
      } else if (recipe.type === "impact") {
        // Impact Cut: quick punch-zoom then hard cut
        filter += `[${vLabel}][${i}:v]concat=n=2:v=1:a=0[${outV}];`;
        filter += `[${aLabel}][${i}:a]concat=n=2:v=0:a=1[${outA}];`;
      } else if (recipe.type === "flash") {
        filter += `[${vLabel}][${i}:v]xfade=transition=fadewhite:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}];`;
        filter += `[${aLabel}][${i}:a]acrossfade=d=${dur.toFixed(3)}[${outA}];`;
      } else {
        const xfadeType = recipe.xfade === "fadeblack" ? "fadeblack" : "fade";
        filter += `[${vLabel}][${i}:v]xfade=transition=${xfadeType}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}];`;
        filter += `[${aLabel}][${i}:a]acrossfade=d=${dur.toFixed(3)}[${outA}];`;
      }

      vLabel = outV;
      aLabel = outA;
      cumulative += durations[i] - dur;
    }

    filter = filter.replace(/;$/, "");

    const xfadeArgs = [
      ...inputArgs,
      "-filter_complex", filter,
      "-map", `[${vLabel}]`,
      "-map", `[${aLabel}]`,
      "-c:v", renderOptions.videoCodec || "libx264",
      "-preset", renderOptions.preset || "faster",
      "-crf", String(renderOptions.crf || 21),
      "-c:a", "aac",
      "-b:a", renderOptions.audioBitrate || "192k",
      "-movflags", "+faststart",
      "-y",
      outPath
    ];

    try {
      await spawnFfmpeg(xfadeArgs, "xfade cinematic transition concat");
      console.log(`[concat] ✓ xfade concat succeeded`);
    } catch (err) {
      console.warn(`[concat] xfade concat failed (${err.message.split("\n")[0]}), falling back to stream-copy`);
      const fallbackList = path.join(TEMP_ROOT, `concat_fallback_${Date.now()}.txt`);
      fs.writeFileSync(fallbackList, segPaths.map(s => `file '${s}'`).join("\n"), "utf8");
      try {
        await spawnFfmpeg(["-f", "concat", "-safe", "0", "-i", fallbackList, "-c", "copy", "-movflags", "+faststart", "-y", outPath], "fallback stream-copy concat");
      } finally {
        try { fs.unlinkSync(fallbackList); } catch (_) {}
      }
    }
  }

  const memAfterMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[concat] END — mem=${memAfterMB}MB → ${outPath}`);
}

// ================================
// v2.5 — BGM range ducking mix pass
// bgmRanges: [{ id, track, fromPanel, toPanel, volume }]
// `track` resolves against the SFX asset library (uploaded via
// POST /assets/sfx) — BGM beds are just longer audio assets. Ranges are
// mixed in under the existing narration/SFX track at a quiet default
// volume (0.1) to approximate ducking without needing a sidechain pass.
// ================================

async function applyBgmDucking(finalPath, bgmRanges, durations, jobId) {
  const cfg = loadMotionConfig();
  const defaultVolume = (cfg.bgm && cfg.bgm.duckVolume) || 0.1;

  const starts = [];
  let cum = 0;
  for (let i = 0; i < durations.length; i++) {
    starts.push(cum);
    cum += durations[i];
  }
  const totalDuration = cum;

  const resolved = [];
  for (const range of bgmRanges) {
    if (!range || !range.track) continue;
    const trackPath = findAsset("sfx", range.track) || findAsset("vfx", range.track);
    if (!trackPath) {
      addJobWarning(jobId, `BGM range ${range.id || ""}: track "${range.track}" not found — skipped.`);
      continue;
    }
    const fromPanel = Math.max(1, Number(range.fromPanel || 1));
    const toPanel   = Math.max(fromPanel, Number(range.toPanel || durations.length));
    const startIdx  = Math.min(durations.length - 1, fromPanel - 1);
    const endIdx    = Math.min(durations.length - 1, toPanel - 1);
    const startTime = starts[startIdx] || 0;
    const endTime   = Math.min(totalDuration, (starts[endIdx] || 0) + (durations[endIdx] || 0));
    const rangeDuration = Math.max(0.1, endTime - startTime);
    const volume = Number(range.volume != null ? range.volume : defaultVolume) || defaultVolume;
    resolved.push({ trackPath, startTime, rangeDuration, volume });
  }

  if (!resolved.length) return;

  const mixedPath = path.join(TEMP_ROOT, `bgmmix_${jobId}.mp4`);
  const args = ["-y", "-i", finalPath];
  resolved.forEach((r) => { args.push("-stream_loop", "-1", "-i", r.trackPath); });

  const complexParts = [];
  const labels = ["0:a"];
  resolved.forEach((r, i) => {
    const inputIdx = i + 1;
    const delayMs = Math.max(0, Math.round(r.startTime * 1000));
    const vol = escFilterArg(Math.max(0, Math.min(1, r.volume)).toFixed(3));
    const label = `bgm${i}`;
    complexParts.push(
      `[${inputIdx}:a]atrim=duration=${r.rangeDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol},adelay=${delayMs}|${delayMs}[${label}]`
    );
    labels.push(`[${label}]`);
  });
  complexParts.push(`${labels.map(l => l.startsWith("[") ? l : `[${l}]`).join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0[outa]`);

  args.push(
    "-filter_complex", complexParts.join(";"),
    "-map", "0:v",
    "-map", "[outa]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    mixedPath
  );

  try {
    await spawnFfmpeg(args, "BGM range ducking mix");
    fs.copyFileSync(mixedPath, finalPath);
  } finally {
    try { fs.unlinkSync(mixedPath); } catch (_) {}
  }
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

      // v2.5 — Cinematic layer: motion + transition keywords, VFX + SFX overlays.
      // Accepted as nested JSON fields (motion, transition, vfx, sfx) OR flat
      // form fields (vfxName/vfx_name, vfxMode, vfxOffset, vfxEnabled, vfxOpacity,
      // sfxName/sfx_name, sfxOffset, sfxVolume, sfxEnabled). Everything optional.
      const motion     = coerceMotion(req.body.motion);
      const transition = coerceTransition(req.body.transition);

      let vfxMeta = null;
      try {
        const raw = req.body.vfx;
        if (raw) vfxMeta = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (_) { vfxMeta = null; }
      const vfxName = vfxMeta?.name ?? req.body.vfxName ?? req.body.vfx_name ?? null;
      if (vfxName) {
        vfxMeta = {
          name:    String(vfxName),
          mode:    String(vfxMeta?.mode ?? req.body.vfxMode ?? req.body.vfx_mode ?? "EVENT").toUpperCase() === "CONTINUOUS" ? "CONTINUOUS" : "EVENT",
          offset:  Number(vfxMeta?.offset ?? req.body.vfxOffset ?? req.body.vfx_offset ?? 0) || 0,
          enabled: !(vfxMeta?.enabled === false || req.body.vfxEnabled === "false" || req.body.vfxEnabled === false || req.body.vfx_enabled === "false"),
          opacity: Number(vfxMeta?.opacity ?? req.body.vfxOpacity ?? req.body.vfx_opacity ?? 0.5) || 0.5
        };
      } else {
        vfxMeta = null;
      }

      let sfxMeta = null;
      try {
        const raw = req.body.sfx;
        if (raw) sfxMeta = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (_) { sfxMeta = null; }
      const sfxName = sfxMeta?.name ?? req.body.sfxName ?? req.body.sfx_name ?? null;
      if (sfxName) {
        sfxMeta = {
          name:    String(sfxName),
          offset:  Number(sfxMeta?.offset ?? req.body.sfxOffset ?? req.body.sfx_offset ?? 0) || 0,
          volume:  Number(sfxMeta?.volume ?? req.body.sfxVolume ?? req.body.sfx_volume ?? 1) || 1,
          enabled: !(sfxMeta?.enabled === false || req.body.sfxEnabled === "false" || req.body.sfxEnabled === false || req.body.sfx_enabled === "false")
        };
      } else {
        sfxMeta = null;
      }

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
          motion,
          transition,
          vfx:         vfxMeta,
          sfx:         sfxMeta,
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
      renderFromProject(req, jobId).catch((err) => {
        console.error(`[${jobId}] Unhandled project render error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
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
      renderFromMultipart(req, jobId).catch((err) => {
        console.error(`[${jobId}] Unhandled multipart render error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
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

  // v2.5 — global/ranged VFX + SFX + BGM ducking + preview panel window.
  let vfxGlobal = null;
  try {
    const raw = body.vfxGlobal || body.vfx_global;
    if (raw) vfxGlobal = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { vfxGlobal = null; }
  if (vfxGlobal && (vfxGlobal.enabled === false || vfxGlobal.enabled === "false")) vfxGlobal = null;

  let sfxGlobal = null;
  try {
    const raw = body.sfxGlobal || body.sfx_global;
    if (raw) sfxGlobal = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { sfxGlobal = null; }
  if (sfxGlobal && (sfxGlobal.enabled === false || sfxGlobal.enabled === "false")) sfxGlobal = null;

  let vfxRanges = [];
  try {
    const raw = body.vfxRanges || body.vfx_ranges;
    if (raw) vfxRanges = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { vfxRanges = []; }
  if (!Array.isArray(vfxRanges)) vfxRanges = [];

  let bgmRanges = [];
  try {
    const raw = body.bgmRanges || body.bgm_ranges;
    if (raw) bgmRanges = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { bgmRanges = []; }
  if (!Array.isArray(bgmRanges)) bgmRanges = [];

  const rawFromPanel = body.fromPanel != null ? body.fromPanel : body.from_panel;
  const rawToPanel   = body.toPanel   != null ? body.toPanel   : body.to_panel;
  const fromPanel = rawFromPanel != null && rawFromPanel !== "" ? Math.max(1, Number(rawFromPanel)) : null;
  const toPanel   = rawToPanel   != null && rawToPanel   !== "" ? Math.max(1, Number(rawToPanel))   : null;

  return {
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
    vfxGlobal,
    sfxGlobal,
    vfxRanges,
    bgmRanges,
    fromPanel,
    toPanel
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
  const renderOptions = extractRenderOptions(req.body);
  if (req._overlayPath && fs.existsSync(req._overlayPath)) {
    renderOptions.overlayPath = req._overlayPath;
  }

  // v2.5 — /render/preview (or any caller) may restrict rendering to a
  // 1-based inclusive panel window via fromPanel/toPanel.
  if (renderOptions.fromPanel != null || renderOptions.toPanel != null) {
    const startIdx = renderOptions.fromPanel != null ? Math.max(0, renderOptions.fromPanel - 1) : 0;
    const endIdx   = renderOptions.toPanel   != null ? Math.min(panels.length, renderOptions.toPanel) : panels.length;
    panels = panels.slice(startIdx, Math.max(startIdx, endIdx));
    if (!panels.length) {
      return updateJob(jobId, { status: "error", error: "fromPanel/toPanel window selected no panels" });
    }
  }

  const panelCount = panels.length;

  updateJob(jobId, { batchIndex, totalBatches });

  const segPaths  = [];
  const durations = [];

  try {
    console.log(`[${RENDERER_NAME}][${jobId}] Starting validation — ${panels.length} panels`);
    await validateRenderPanels(panels);

    console.log(`[${RENDERER_NAME}][${jobId}] Starting render — ${panels.length} panels — batch ${batchIndex + 1}/${totalBatches} — panelCount=${panelCount}`);

    let skipped = 0;
    const transitionsList = [];
    for (let i = 0; i < panels.length; i++) {
      const p   = panels[i];
      p.index = i;
      const panelNum = i + 1;
      const dur = await calculatePanelDuration(p);
      const segPath = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);

      // v2.5 — per-panel motion/transition/vfx/sfx metadata wiring.
      transitionsList.push(p.transition || "Hard Cut");

      const perPanelOpts = {
        ...renderOptions,
        zoomFactor: Number(p.zoom || 1),
        focusX:     Number(p.focusX != null ? p.focusX : 0.5),
        focusY:     Number(p.focusY != null ? p.focusY : 0.5),
        motion:     p.motion || null
      };

      // VFX: panel's own cue wins; otherwise the first matching vfxRanges
      // entry (fromPanel..toPanel, 1-based inclusive); otherwise vfxGlobal.
      let vfxCandidate = (p.vfx && p.vfx.enabled !== false && p.vfx.name) ? p.vfx : null;
      if (!vfxCandidate) {
        const rangeHit = (renderOptions.vfxRanges || []).find(r =>
          r && r.name && panelNum >= Number(r.fromPanel || 1) && panelNum <= Number(r.toPanel || Infinity)
        );
        if (rangeHit) {
          vfxCandidate = rangeHit;
        } else if (renderOptions.vfxGlobal && renderOptions.vfxGlobal.name) {
          const g = renderOptions.vfxGlobal;
          const inRange = g.fromPanel == null || (panelNum >= Number(g.fromPanel) && panelNum <= Number(g.toPanel || Infinity));
          if (inRange) vfxCandidate = g;
        }
      }
      if (vfxCandidate && vfxCandidate.name) {
        const vfxPath = findAsset("vfx", vfxCandidate.name);
        if (vfxPath) {
          perPanelOpts.vfxPath = vfxPath;
          perPanelOpts.vfxMeta = {
            mode:    String(vfxCandidate.mode || "EVENT").toUpperCase() === "CONTINUOUS" ? "CONTINUOUS" : "EVENT",
            offset:  Number(vfxCandidate.offset || 0) || 0,
            opacity: Number(vfxCandidate.opacity != null ? vfxCandidate.opacity : 0.5) || 0.5
          };
        } else {
          addJobWarning(jobId, `Panel ${panelNum}: VFX asset "${vfxCandidate.name}" not found — rendered without VFX.`);
        }
      }

      // SFX: panel's own cue plus any matching sfxGlobal cue both play.
      const sfxCandidates = [];
      if (p.sfx && p.sfx.enabled !== false && p.sfx.name) sfxCandidates.push(p.sfx);
      if (renderOptions.sfxGlobal && renderOptions.sfxGlobal.name) {
        const g = renderOptions.sfxGlobal;
        const inRange = g.fromPanel == null || (panelNum >= Number(g.fromPanel) && panelNum <= Number(g.toPanel || Infinity));
        if (inRange) sfxCandidates.push(g);
      }
      const sfxList = [];
      sfxCandidates.forEach((s) => {
        const sfxPath = findAsset("sfx", s.name);
        if (sfxPath) {
          sfxList.push({ path: sfxPath, offset: Number(s.offset || 0) || 0, volume: Number(s.volume != null ? s.volume : 1) || 1 });
        } else {
          addJobWarning(jobId, `Panel ${panelNum}: SFX asset "${s.name}" not found — rendered without that SFX cue.`);
        }
      });
      if (sfxList.length) perPanelOpts.sfxList = sfxList;

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

      if (result.success) {
        segPaths.push(segPath);
        durations.push(dur);
      } else {
        skipped++;
        console.warn(`[${jobId}] Panel ${i + 1} skipped (${skipped} total skipped)`);
        addJobWarning(jobId, `Panel ${panelNum}: failed to render and was skipped (${result.error ? String(result.error).split("\n")[0] : "unknown error"}).`);
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

    renderOptions.transitions = transitionsList;

    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatWithTransitions(segPaths, durations, finalPath, renderOptions);
    cleanupFiles(segPaths);

    // v2.5 — BGM range ducking mix pass (best-effort; never fails the job).
    if (Array.isArray(renderOptions.bgmRanges) && renderOptions.bgmRanges.length) {
      try {
        await applyBgmDucking(finalPath, renderOptions.bgmRanges, durations, jobId);
      } catch (bgmErr) {
        console.warn(`[${jobId}] BGM ducking pass failed, keeping video without BGM: ${bgmErr.message}`);
        addJobWarning(jobId, `BGM mix failed: ${bgmErr.message.split("\n")[0]}`);
      }
    }

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
      fps: 15,
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
      fps: 15,
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
// v2.5 — VFX / SFX asset library endpoints
// ================================

const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 }
});

function handleAssetUpload(kind) {
  return (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: "file is required" });
      }
      const name = safeName(req.body.name, "");
      if (!name) {
        return res.status(400).json({ success: false, error: "name is required" });
      }
      const root = kind === "vfx" ? ASSETS_VFX_ROOT : ASSETS_SFX_ROOT;
      const ext = extFor(req.file, kind === "vfx" ? ".mp4" : ".mp3");

      // Idempotent by semantic name — replace any existing file(s) with this name.
      try {
        fs.readdirSync(root)
          .filter((f) => path.basename(f, path.extname(f)) === name)
          .forEach((f) => { try { fs.unlinkSync(path.join(root, f)); } catch (_) {} });
      } catch (_) {}

      const outFile = `${name}${ext}`;
      fs.writeFileSync(path.join(root, outFile), req.file.buffer);

      console.log(`[assets] saved ${kind}/${outFile}`);

      return res.json({ success: true, kind, name, file: outFile });
    } catch (err) {
      console.error(`/assets/${kind} error:`, err);
      return res.status(500).json({ success: false, error: err.message });
    }
  };
}

app.post("/assets/vfx", assetUpload.single("file"), handleAssetUpload("vfx"));
app.post("/assets/sfx", assetUpload.single("file"), handleAssetUpload("sfx"));

app.get("/assets", (req, res) => {
  res.json({
    success: true,
    vfx: listAssets("vfx"),
    sfx: listAssets("sfx")
  });
});

// ================================
// v2.5 — Preview render: only panels fromPanel..toPanel (1-based inclusive)
// ================================

app.post("/render/preview", (req, res) => {
  const runPreview = () => {
    if (req.body && typeof req.body.payload === "string") {
      try {
        const parsed = JSON.parse(req.body.payload);
        for (const k of Object.keys(parsed)) {
          if (req.body[k] == null) req.body[k] = parsed[k];
        }
      } catch (_) {}
    }
    if (req.files) {
      const f = req.files.overlay?.[0] || req.files.overlayLogo?.[0] || req.files.watermark?.[0];
      if (f) req._overlayPath = f.path;
    }

    const hasProjectId = req.body?.project_id || req.body?.projectId;
    if (!hasProjectId) {
      return res.status(400).json({ success: false, error: "project_id is required for /render/preview" });
    }

    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });

    setImmediate(() => {
      renderFromProject(req, jobId).catch((err) => {
        console.error(`[${jobId}] Unhandled preview render error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
    });
  };

  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("multipart/form-data")) {
    overlayUpload.fields([
      { name: "overlay",     maxCount: 1 },
      { name: "overlayLogo", maxCount: 1 },
      { name: "watermark",   maxCount: 1 }
    ])(req, res, (err) => {
      if (err) {
        console.error("[/render/preview] overlay multer error:", err.message);
        return res.status(400).json({ success: false, error: err.message });
      }
      runPreview();
    });
  } else {
    runPreview();
  }
});

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
