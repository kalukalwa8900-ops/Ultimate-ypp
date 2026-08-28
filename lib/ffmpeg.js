"use strict";

const { spawn } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(bin, args, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > 200000) out = out.slice(-100000);
    });
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onLog) onLog(s);
    });
    p.on("error", reject);
    p.on("close", (code, signal) => {
      if (code === 0) resolve({ out, err });
      else {
        const reason = signal ? `signal=${signal}` : `exitCode=${code}`;
        const e = new Error(`${bin} failed (${reason}): ${err.slice(-4000)}`);
        e.exitCode = code;
        e.signal = signal;
        e.stderr = err;
        reject(e);
      }
    });
  });
}

function ffmpeg(args, opts) {
  // Railway Free-tier safe defaults. Override with FFMPEG_THREADS if needed.
  const threads = Math.max(1, Math.min(4, Number(process.env.FFMPEG_THREADS) || 2));
  return run(
    FFMPEG,
    [
      "-hide_banner", "-nostdin", "-y",
      "-threads", String(threads),
      "-filter_threads", "1",
      "-filter_complex_threads", "1",
      ...args,
    ],
    opts,
  );
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
  } catch {
    return null;
  }
}

const DEFAULT_W = 1280;
const DEFAULT_H = 720;

function outputSize(width, height) {
  const w = Number(width) || DEFAULT_W;
  const h = Number(height) || DEFAULT_H;
  if (w < 320 || h < 180 || w > 3840 || h > 2160) {
    throw new Error(`invalid output size ${w}x${h}`);
  }
  return { W: Math.round(w / 2) * 2, H: Math.round(h / 2) * 2 };
}

// ---------------------------------------------------------------------------
// Motion — lightweight, output-resolution-aware Ken Burns.
// Static deliberately avoids zoompan.
// ---------------------------------------------------------------------------
function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function motionFilter(motion, durSec, fps, width = DEFAULT_W, height = DEFAULT_H) {
  const { W, H } = outputSize(width, height);
  const frames = Math.max(1, Math.round(durSec * fps));
  const m = normalize(motion);

  // Small supersampling only for animated motion; never 3840x2160 by default.
  const SW = Math.min(Math.round(W * 1.25 / 2) * 2, 1920);
  const SH = Math.min(Math.round(H * 1.25 / 2) * 2, 1080);
  const base = `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH}`;
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
      return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}`;
    default:
      return `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH},zoompan=z='min(1.0+0.00035*on,1.15)':x='${cx}':y='${cy}':d=${frames}:s=${W}x${H}:fps=${fps}`;
  }
}

function fitFilter(fit, width = DEFAULT_W, height = DEFAULT_H) {
  const { W, H } = outputSize(width, height);
  const f = normalize(fit);
  if (f === "contain" || f === "letterbox") {
    return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }
  if (f === "blur pad" || f === "blurpad" || f === "blur") {
    return (
      `split=2[bg][fg];` +
      `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1[bgb];` +
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
  outputSize,
};
