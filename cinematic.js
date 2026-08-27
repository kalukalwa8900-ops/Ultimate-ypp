// ================================
// cinematic.js — Video Renderer Backend v2.5
// Cinematic motion + transition vocabulary, driven by motion.config.json
// ================================

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "motion.config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {
    return {
      zoom: {
        slowZoomInStart: 1.0, slowZoomInEnd: 1.04,
        slowZoomOutStart: 1.04, slowZoomOutEnd: 1.0,
        slowPushInStart: 1.0, slowPushInEnd: 1.10,
        slowPullBackStart: 1.12, slowPullBackEnd: 1.0,
        focusPushStart: 1.0, focusPushEnd: 1.22,
        fastPushStart: 1.0, fastPushEnd: 1.16, fastPushRate: 0.006
      },
      pan: { panDistancePct: 0.10, panZoom: 1.12, fastPanZoom: 1.14, fastPanDistancePct: 0.14 },
      shake: { amplitudePx: 6, frequencyHz: 6, zoom: 1.06 },
      transitions: {
        crossDissolveDuration: 0.5, fadeToBlackDuration: 0.4, fadeFromBlackDuration: 0.4,
        impactCutZoomDuration: 0.15, impactCutZoomAmount: 1.08, flashCutFrames: 2
      },
      vfx: { defaultOpacity: 0.5 },
      sfx: { defaultVolume: 1.0 },
      bgm: { duckVolume: 0.10 }
    };
  }
}

// ================================
// Helpers
// ================================

// Escape a value for safe use inside an ffmpeg filtergraph string
// (single-quoted literal args, filter-option separators, etc.)
function escFilterArg(value) {
  return String(value)
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\\\\\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/;/g, "\\;");
}

// Escape a path for use inside a filtergraph (e.g. concat file list already handles quoting elsewhere)
function escFilterPath(p) {
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function zoompanChain(zStart, zEnd, xExpr, yExpr, totalFrames, w, h, fps) {
  const zExpr = zEnd >= zStart
    ? `min(zoom+${((zEnd - zStart) / Math.max(1, totalFrames)).toFixed(6)},${zEnd})`
    : `max(zoom-${((zStart - zEnd) / Math.max(1, totalFrames)).toFixed(6)},${zEnd})`;
  return `scale=2560:-1,zoompan=z='if(lte(on\\,1)\\,${zStart}\\,${zExpr})':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
}

// ================================
// MOTION_MAP — keyword -> builder(width,height,durationSec,fps,cfg)
// Each builder returns a complete ffmpeg zoompan/crop filter string.
// ================================

const MOTION_MAP = {
  "Static": (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,

  "Slow Zoom In": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { slowZoomInStart: zs, slowZoomInEnd: ze } = cfg.zoom;
    return zoompanChain(zs, ze, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)", totalFrames, w, h, fps);
  },

  "Slow Zoom Out": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { slowZoomOutStart: zs, slowZoomOutEnd: ze } = cfg.zoom;
    return zoompanChain(zs, ze, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)", totalFrames, w, h, fps);
  },

  "Slow Push In": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { slowPushInStart: zs, slowPushInEnd: ze } = cfg.zoom;
    return zoompanChain(zs, ze, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)", totalFrames, w, h, fps);
  },

  "Slow Pull Back": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { slowPullBackStart: zs, slowPullBackEnd: ze } = cfg.zoom;
    return zoompanChain(zs, ze, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)", totalFrames, w, h, fps);
  },

  "Pan Left": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { panZoom: z, panDistancePct: d } = cfg.pan;
    const from = (0.5 + d).toFixed(3), to = (0.5 - d).toFixed(3);
    const xExpr = `if(lte(on\\,1)\\,iw*${from}-(iw/zoom/2)\\,max(x-iw*${(2 * d / totalFrames).toFixed(6)}\\,iw*${to}-(iw/zoom/2)))`;
    return `scale=2560:-1,zoompan=z='${z}':x='${xExpr}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  },

  "Pan Right": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { panZoom: z, panDistancePct: d } = cfg.pan;
    const from = (0.5 - d).toFixed(3), to = (0.5 + d).toFixed(3);
    const xExpr = `if(lte(on\\,1)\\,iw*${from}-(iw/zoom/2)\\,min(x+iw*${(2 * d / totalFrames).toFixed(6)}\\,iw*${to}-(iw/zoom/2)))`;
    return `scale=2560:-1,zoompan=z='${z}':x='${xExpr}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  },

  "Pan Up": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { panZoom: z, panDistancePct: d } = cfg.pan;
    const from = (0.5 + d).toFixed(3), to = (0.5 - d).toFixed(3);
    const yExpr = `if(lte(on\\,1)\\,ih*${from}-(ih/zoom/2)\\,max(y-ih*${(2 * d / totalFrames).toFixed(6)}\\,ih*${to}-(ih/zoom/2)))`;
    return `scale=2560:-1,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  },

  "Pan Down": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { panZoom: z, panDistancePct: d } = cfg.pan;
    const from = (0.5 - d).toFixed(3), to = (0.5 + d).toFixed(3);
    const yExpr = `if(lte(on\\,1)\\,ih*${from}-(ih/zoom/2)\\,min(y+ih*${(2 * d / totalFrames).toFixed(6)}\\,ih*${to}-(ih/zoom/2)))`;
    return `scale=2560:-1,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  },

  "Focus Push": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { focusPushStart: zs, focusPushEnd: ze } = cfg.zoom;
    return zoompanChain(zs, ze, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)", totalFrames, w, h, fps);
  },

  "Fast Push": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { fastPushStart: zs, fastPushEnd: ze } = cfg.zoom;
    return zoompanChain(zs, ze, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)", totalFrames, w, h, fps);
  },

  "Fast Pan": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { fastPanZoom: z, fastPanDistancePct: d } = cfg.pan;
    const from = (0.5 - d).toFixed(3), to = (0.5 + d).toFixed(3);
    const xExpr = `if(lte(on\\,1)\\,iw*${from}-(iw/zoom/2)\\,min(x+iw*${(2 * d / totalFrames).toFixed(6)}\\,iw*${to}-(iw/zoom/2)))`;
    return `scale=2560:-1,zoompan=z='${z}':x='${xExpr}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  },

  "Shake": (w, h, dur, fps, cfg) => {
    const totalFrames = Math.ceil(dur * fps);
    const { amplitudePx: amp, frequencyHz: freq, zoom: z } = cfg.shake;
    const xExpr = `iw/2-(iw/zoom/2)+${amp}*sin(2*PI*${freq}*on/${fps})`;
    const yExpr = `ih/2-(ih/zoom/2)+${amp}*cos(2*PI*${freq}*on/${fps})`;
    return `scale=2560:-1,zoompan=z='${z}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  }
};

const MOTION_KEYS = Object.keys(MOTION_MAP);

function coerceMotion(value) {
  const v = String(value || "").trim();
  if (MOTION_MAP[v]) return v;
  // Case-insensitive / loose match
  const found = MOTION_KEYS.find(k => k.toLowerCase() === v.toLowerCase());
  return found || "Static";
}

// ================================
// TRANSITION_MAP — keyword -> { type, duration } recipe for xfade/fade
// ================================

const TRANSITION_MAP = {
  "Hard Cut":        (cfg) => ({ type: "hardcut", duration: 0 }),
  "Cross Dissolve":  (cfg) => ({ type: "fade",    duration: cfg.transitions.crossDissolveDuration, xfade: "fade" }),
  "Fade To Black":   (cfg) => ({ type: "fade",    duration: cfg.transitions.fadeToBlackDuration,   xfade: "fadeblack" }),
  "Fade From Black": (cfg) => ({ type: "fade",    duration: cfg.transitions.fadeFromBlackDuration, xfade: "fadeblack" }),
  "Impact Cut":      (cfg) => ({ type: "impact",  duration: cfg.transitions.impactCutZoomDuration, zoom: cfg.transitions.impactCutZoomAmount }),
  "Flash Cut":       (cfg) => ({ type: "flash",   duration: cfg.transitions.flashCutFrames / 15, frames: cfg.transitions.flashCutFrames })
};

const TRANSITION_KEYS = Object.keys(TRANSITION_MAP);

function coerceTransition(value) {
  const v = String(value || "").trim();
  if (TRANSITION_MAP[v]) return v;
  const found = TRANSITION_KEYS.find(k => k.toLowerCase() === v.toLowerCase());
  return found || "Hard Cut";
}

function getMotionFilter(motionKeyword, width, height, durationSec, fps, cfg) {
  const key = coerceMotion(motionKeyword);
  return MOTION_MAP[key](width, height, durationSec, fps, cfg || loadConfig());
}

function getTransitionRecipe(transitionKeyword, cfg) {
  const key = coerceTransition(transitionKeyword);
  return { name: key, ...TRANSITION_MAP[key](cfg || loadConfig()) };
}

module.exports = {
  loadConfig,
  MOTION_MAP,
  TRANSITION_MAP,
  MOTION_KEYS,
  TRANSITION_KEYS,
  coerceMotion,
  coerceTransition,
  getMotionFilter,
  getTransitionRecipe,
  escFilterArg,
  escFilterPath
};
