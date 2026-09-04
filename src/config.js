"use strict";
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");

const DIRS = {
  root: ROOT,
  data: path.join(ROOT, "data"),
  projects: path.join(ROOT, "data", "projects"),
  output: path.join(ROOT, "output"),
  cache: path.join(ROOT, "cache"),
  vfxCache: path.join(ROOT, "cache", "vfx"),
  assets: path.join(ROOT, "assets"),
  vfx: path.join(ROOT, "assets", "vfx"),
  sfx: path.join(ROOT, "assets", "sfx"),
  uploadTmp: path.join(ROOT, "data", "tmp"),
};

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// ---- single source of truth for output geometry / timing ----
const RESOLUTIONS = {
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
};
const ALLOWED_FPS = [25, 20, 15];

const DEFAULTS = {
  resolution: "1080p",
  fps: 25,
  vfx_enabled: true,
  vfx_opacity: 0.8,
  sfx_enabled: true,
  sfx_volume: 0.1,
  filter: "none",
};

const FILTERS = {
  none: null,
  warm: "eq=saturation=1.08:gamma_r=1.04:gamma_b=0.97",
  cool: "eq=saturation=1.05:gamma_b=1.05:gamma_r=0.97",
  cinematic: "eq=contrast=1.08:saturation=1.06:gamma=0.98",
  bw: "hue=s=0",
};

const ENCODE = {
  crf: Number(process.env.CRF || 21),
  preset: process.env.X264_PRESET || "veryfast",
  audioBitrate: "160k",
  audioRate: 48000,
};

const SERVER = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "0.0.0.0",
  // Public base used to build the local video URL. Always http for localhost.
  publicBase: (process.env.PUBLIC_BASE || `http://localhost:${Number(process.env.PORT || 8080)}`).replace(/\/+$/, ""),
  maxConcurrentFfmpeg: Math.max(1, Number(process.env.MAX_CONCURRENT_FFMPEG || 1)),
  keepTemp: /^(1|true|yes)$/i.test(String(process.env.KEEP_TEMP || "")),
  transitionSeconds: Number(process.env.TRANSITION_SECONDS || 0.5),
};

const BIN = {
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH || "ffprobe",
};

/** Normalizes client settings into the one true render config. */
function resolveSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const pick = (a, b) => (a === undefined || a === null ? b : a);

  const resKey = RESOLUTIONS[s.resolution] ? s.resolution : DEFAULTS.resolution;
  const { width, height } = RESOLUTIONS[resKey];

  let fps = Number(pick(s.fps, DEFAULTS.fps));
  if (!ALLOWED_FPS.includes(fps)) fps = DEFAULTS.fps;

  const clamp01 = (v, d) => {
    const n = Number(pick(v, d));
    if (!Number.isFinite(n)) return d;
    return Math.min(1, Math.max(0, n));
  };

  const filterKey = Object.prototype.hasOwnProperty.call(FILTERS, s.filter) ? s.filter : "none";

  return {
    resolution: resKey,
    width,
    height,
    fps,
    vfxEnabled: pick(pick(s.vfx_enabled, s.vfxEnabled), DEFAULTS.vfx_enabled) !== false,
    vfxOpacity: clamp01(pick(s.vfx_opacity, s.vfxOpacity), DEFAULTS.vfx_opacity),
    sfxEnabled: pick(pick(s.sfx_enabled, s.sfxEnabled), DEFAULTS.sfx_enabled) !== false,
    sfxVolume: clamp01(pick(s.sfx_volume, s.sfxVolume), DEFAULTS.sfx_volume),
    filter: filterKey,
    filterExpr: FILTERS[filterKey],
    motion: "automatic",
    transitions: "automatic",
  };
}

module.exports = { DIRS, RESOLUTIONS, ALLOWED_FPS, DEFAULTS, FILTERS, ENCODE, SERVER, BIN, resolveSettings };
