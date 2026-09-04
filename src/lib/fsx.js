"use strict";
const fs = require("fs");
const path = require("path");
const { DIRS } = require("../config");

/** Strips directories and dangerous characters from an untrusted filename. */
function sanitizeName(name) {
  const base = String(name || "file").replace(/\\/g, "/").split("/").pop();
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return clean || "file";
}

/** Joins inside `base` and throws if the result escapes it. */
function safeJoin(base, ...parts) {
  const target = path.resolve(base, ...parts);
  const rootWithSep = path.resolve(base) + path.sep;
  if (target !== path.resolve(base) && !target.startsWith(rootWithSep)) {
    throw new Error("Unsafe path");
  }
  return target;
}

const NUM_RE = /(\d+)/g;
/** Natural sort: 1,2,9,10,11 (not 1,10,11,2). */
function naturalCompare(a, b) {
  const as = String(a), bs = String(b);
  const ax = as.split(NUM_RE), bx = bs.split(NUM_RE);
  const n = Math.max(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i] ?? "", y = bx[i] ?? "";
    const nx = Number(x), ny = Number(y);
    if (x !== "" && y !== "" && !Number.isNaN(nx) && !Number.isNaN(ny) && /^\d+$/.test(x) && /^\d+$/.test(y)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
function naturalSort(list) {
  return list.slice().sort(naturalCompare);
}

/** Leading integer of a filename, or null. */
function leadingNumber(filename) {
  const m = String(filename).replace(/^.*[/\\]/, "").match(/^(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectDir(projectId) {
  const id = sanitizeName(projectId);
  if (!id) throw new Error("Invalid projectId");
  return safeJoin(DIRS.projects, id);
}

function projectPaths(projectId) {
  const root = projectDir(projectId);
  return {
    id: sanitizeName(projectId),
    root,
    images: path.join(root, "images"),
    audio: path.join(root, "audio"),
    tmp: path.join(root, "tmp"),
  };
}

function ensureProject(projectId) {
  const p = projectPaths(projectId);
  ensureDir(p.root); ensureDir(p.images); ensureDir(p.audio); ensureDir(p.tmp);
  return p;
}

function listFiles(dir, extRe) {
  if (!fs.existsSync(dir)) return [];
  return naturalSort(
    fs.readdirSync(dir).filter((f) => {
      if (f.startsWith(".")) return false;
      const st = fs.statSync(path.join(dir, f));
      if (!st.isFile()) return false;
      return extRe ? extRe.test(f) : true;
    }),
  );
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const IMAGE_RE = /\.(png|jpe?g|webp|bmp)$/i;
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v)$/i;

module.exports = {
  sanitizeName, safeJoin, naturalSort, naturalCompare, leadingNumber,
  ensureDir, projectDir, projectPaths, ensureProject, listFiles, rmrf, newId,
  IMAGE_RE, AUDIO_RE, VIDEO_RE,
};
