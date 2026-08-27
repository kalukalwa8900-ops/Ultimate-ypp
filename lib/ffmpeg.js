"use strict";

const { spawn } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const DEFAULT_W = Number(process.env.OUTPUT_W) || 1920;
const DEFAULT_H = Number(process.env.OUTPUT_H) || 1080;

function run(bin, args, { onLog, context } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = `${bin} ${args.map((a) => (String(a).includes(' ') ? JSON.stringify(a) : a)).join(" ")}`;
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";

    p.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 200000) out = out.slice(-100000);
      if (onLog) onLog(s);
    });
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onLog) onLog(s);
    });

    p.on("error", (e) => {
      const e2 = new Error(`Failed to start ${bin}: ${e.message}`);
      e2.command = cmd;
      e2.context = context || null;
      reject(e2);
    });

    p.on("close", (code, signal) => {
      // include both code and signal for clearer diagnostics
      if (code === 0 && !signal) return resolve({ out, err, code, signal });
      const errMsg = err.slice(-5000);
      const e = new Error(`${bin} exited ${code} ${signal || ""}: ${errMsg}`);
      e.code = code;
      e.signal = signal;
      e.stderr = err;
      e.stdout = out;
      e.command = cmd;
      e.context = context || null;
      reject(e);
    });
  });
}

function ffmpeg(args, opts) {
  // Attach a short command preview for logs
  return run(FFMPEG, ["-hide_banner", "-nostdin", "-y", ...args], opts);
}

async function probeDuration(file) {
  try {
    const { out } = await run(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    const d = parseFloat(String(out).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Motion (Ken Burns style) — expressions consumed by the zoompan filter.
// Values arrive from the frontend exactly as written in the instruction file.
// ---------------------------------------------------------------------------
function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function motionFilter(motion, durSec, fps, W = DEFAULT_W, H = DEFAULT_H) {
  const frames = Math.max(1, Math.round(durSec * fps));
  const m = normalize(motion);
  // operate on double-resolution internally to keep quality for zoompan math
  const base = `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`;
  const zp = (z, x, y) =>
    `${base},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`;

  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";

  switch (m) {
    case "slow zoom in":
      return zp(`min(1.0+0.00035*on,1.18)`, cx, cy);
    case "slow zoom out":
      return zp(`max(1.18-0.00035*on,1.0)`, cx, cy);
    case "slow push in":
    case "focus push":
      return zp(`min(1.0+0.0005*on,1.25)`, cx, cy);
    case "fast push":
      return zp(`min(1.0+0.0012*on,1.4)`, cx, cy);
    case "slow pull back":
      return zp(`max(1.3-0.0005*on,1.0)`, cx, cy);
    case "pan left":
      return zp(`1.15`, `(iw-iw/zoom)*(1-on/${frames})`, cy);
    case "pan right":
      return zp(`1.15`, `(iw-iw/zoom)*(on/${frames})`, cy);
    case "pan up":
      return zp(`1.15`, cx, `(ih-ih/zoom)*(1-on/${frames})`);
    case "pan down":
      return zp(`1.15`, cx, `(ih-ih/zoom)*(on/${frames})`);
    case "fast pan":
      return zp(`1.2`, `(iw-iw/zoom)*(on/${frames})`, cy);
    case "shake":
      return zp(`1.12`, `${cx}+8*sin(on/2)`, `${cy}+8*cos(on/3)`);
    case "static":
    case "none":
    case "":
      return `${base},scale=${W}:${H},fps=${fps}`;
    default:
      return zp(`min(1.0+0.00035*on,1.15)`, cx, cy);
  }
}

// Fit handling before motion: cover (crop), contain (letterbox), blur-pad.
function fitFilter(fit, W = DEFAULT_W, H = DEFAULT_H) {
  const f = normalize(fit);
  if (f === "contain" || f === "letterbox") {
    return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }
  if (f === "blur pad" || f === "blurpad" || f === "blur") {
    return (
      `split=2[bg][fg];` +
      `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:2[bgb];` +
      `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`
    );
  }
  return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
}

// Manual per-panel zoom / crop focus supplied by the editor.
function manualCrop(zoom, cropX, cropY) {
  const z = Math.max(1, Math.min(4, Number(zoom) || 1));
  if (z <= 1.001) return null;
  const fx = Math.max(0, Math.min(100, Number(cropX ?? 50))) / 100;
  const fy = Math.max(0, Math.min(100, Number(cropY ?? 50))) / 100;
  return `crop=iw/${z}:ih/${z}:(iw-iw/${z})*${fx}:(ih-ih/${z})*${fy}`;
}

// ---------------------------------------------------------------------------
// Transitions -> xfade names + durations
// ---------------------------------------------------------------------------
function transitionSpec(transition) {
  const t = normalize(transition);
  switch (t) {
    case "cross dissolve":
    case "dissolve":
      return { name: "fade", duration: 0.6 };
    case "fade to black":
      return { name: "fadeblack", duration: 0.8 };
    case "fade from black":
      return { name: "fadeblack", duration: 0.8 };
    case "impact cut":
      return { name: "fade", duration: 0.15 };
    case "flash cut":
      return { name: "fadewhite", duration: 0.25 };
    case "hard cut":
    case "cut":
    case "none":
    case "":
      return null;
    default:
      return null;
  }
}

module.exports = {
  FFMPEG,
  FFPROBE,
  ffmpeg,
  run,
  probeDuration,
  motionFilter,
  fitFilter,
  manualCrop,
  transitionSpec,
  normalize,
  DEFAULT_W,
  DEFAULT_H,
};
