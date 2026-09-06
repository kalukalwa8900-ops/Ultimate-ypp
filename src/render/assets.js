"use strict";
const fs = require("fs");
const path = require("path");
const { DIRS } = require("../config");
const { listFiles, sanitizeName, safeJoin, VIDEO_RE, AUDIO_RE } = require("../lib/fsx");
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

/**
 * Uses each VFX source directly. The source is NOT pre-resized, re-encoded,
 * or converted to yuv420p. The render filtergraph performs scaling/FPS
 * adaptation immediately before compositing, which avoids unnecessary
 * color/subsampling changes to the original VFX.
 */
async function prepareVfxAssets(names, settings, onEach) {
  const out = new Map(); // name -> { path, hasAlpha, duration }
  const unique = [...new Set(names.filter(Boolean))];
  let done = 0;
  for (const name of unique) {
    const src = findAsset("vfx", name);
    if (!src) { done++; onEach && onEach(done, unique.length, name); continue; }

    const info = await videoInfo(src);
    out.set(name, { path: src, hasAlpha: info.hasAlpha, duration: info.duration });
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
