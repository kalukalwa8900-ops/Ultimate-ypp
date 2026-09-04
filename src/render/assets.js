"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DIRS } = require("../config");
const { listFiles, sanitizeName, safeJoin, VIDEO_RE, AUDIO_RE, ensureDir } = require("../lib/fsx");
const { videoInfo, ffmpeg } = require("../lib/ffmpeg");

/** Library name = filename without extension. */
function libraryName(file) {
  return path.basename(file, path.extname(file));
}

function listLibrary(kind) {
  const dir = kind === "vfx" ? DIRS.vfx : DIRS.sfx;
  const re = kind === "vfx" ? VIDEO_RE : AUDIO_RE;
  return listFiles(dir, re).map((f) => ({ name: libraryName(f), file: f, kind }));
}

/** Case-insensitive lookup of assets/<kind>/<name>.* */
function findAsset(kind, name) {
  if (!name) return null;
  const wanted = sanitizeName(String(name)).toLowerCase();
  const dir = kind === "vfx" ? DIRS.vfx : DIRS.sfx;
  const re = kind === "vfx" ? VIDEO_RE : AUDIO_RE;
  for (const f of listFiles(dir, re)) {
    if (libraryName(f).toLowerCase() === wanted) return safeJoin(dir, f);
  }
  return null;
}

function fingerprint(file, width, height, fps) {
  const st = fs.statSync(file);
  const h = crypto.createHash("sha1")
    .update(`${path.basename(file)}|${st.size}|${Math.round(st.mtimeMs)}|${width}x${height}@${fps}`)
    .digest("hex").slice(0, 16);
  return h;
}

/**
 * Prepares each UNIQUE vfx asset once per (source fingerprint + resolution + fps)
 * and caches the result. Compatible sources are reused as-is.
 */
async function prepareVfxAssets(names, settings, onEach) {
  ensureDir(DIRS.vfxCache);
  const out = new Map(); // name -> { path, hasAlpha }
  const unique = [...new Set(names.filter(Boolean))];
  let done = 0;
  for (const name of unique) {
    const src = findAsset("vfx", name);
    if (!src) { done++; onEach && onEach(done, unique.length, name); continue; }

    const info = await videoInfo(src);
    const compatible =
      info.width === settings.width &&
      info.height === settings.height &&
      Math.abs(info.fps - settings.fps) < 0.51 &&
      /h264|vp9|prores|qtrle|png/i.test(info.codec);

    if (compatible) {
      out.set(name, { path: src, hasAlpha: info.hasAlpha, duration: info.duration });
    } else {
      const cacheFile = safeJoin(DIRS.vfxCache, `${sanitizeName(name)}_${fingerprint(src, settings.width, settings.height, settings.fps)}.mp4`);
      if (!fs.existsSync(cacheFile)) {
        await ffmpeg([
          "-y", "-i", src,
          "-an",
          "-vf", `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=increase,crop=${settings.width}:${settings.height},fps=${settings.fps},format=yuv420p`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          cacheFile,
        ], { label: `prepare vfx ${name}` });
      }
      const cinfo = await videoInfo(cacheFile);
      out.set(name, { path: cacheFile, hasAlpha: false, duration: cinfo.duration });
    }
    done++;
    onEach && onEach(done, unique.length, name);
  }
  return out;
}

/** SFX are used directly — no preprocessing pass. */
function resolveSfxAssets(names) {
  const out = new Map();
  for (const name of [...new Set(names.filter(Boolean))]) {
    const p = findAsset("sfx", name);
    if (p) out.set(name, { path: p });
  }
  return out;
}

module.exports = { listLibrary, findAsset, prepareVfxAssets, resolveSfxAssets, libraryName };
