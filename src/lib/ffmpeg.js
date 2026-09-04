"use strict";
const { spawn } = require("child_process");
const { BIN, SERVER } = require("../config");

// ---- simple semaphore: keep at most MAX_CONCURRENT_FFMPEG processes alive ----
let active = 0;
const waiters = [];
function acquire() {
  if (active < SERVER.maxConcurrentFfmpeg) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) { active++; next(); }
}

/** Runs ffmpeg with the given args. Resolves on exit code 0. */
async function ffmpeg(args, opts = {}) {
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(BIN.ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args]);
      let err = "";
      child.stderr.on("data", (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
      child.on("error", (e) => reject(new Error(`Cannot start ffmpeg (${BIN.ffmpeg}): ${e.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`ffmpeg failed (${code})${opts.label ? ` [${opts.label}]` : ""}: ${err.trim().split("\n").slice(-6).join(" | ")}`));
      });
    });
  } finally {
    release();
  }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`Cannot start ${bin}: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${bin} exited ${code}`))));
  });
}

/** ffprobe JSON for a media file. */
async function probe(file) {
  const out = await run(BIN.ffprobe, [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file,
  ]);
  return JSON.parse(out);
}

async function mediaDuration(file) {
  const info = await probe(file);
  const d = Number(info?.format?.duration);
  if (Number.isFinite(d) && d > 0) return d;
  for (const s of info?.streams || []) {
    const sd = Number(s.duration);
    if (Number.isFinite(sd) && sd > 0) return sd;
  }
  throw new Error(`Cannot read duration of ${file}`);
}

/** Video stream summary used by the VFX cache. */
async function videoInfo(file) {
  const info = await probe(file);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const fpsStr = v?.avg_frame_rate || v?.r_frame_rate || "0/0";
  const [n, d] = fpsStr.split("/").map(Number);
  return {
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
    fps: d ? n / d : 0,
    codec: v?.codec_name || "",
    pixFmt: v?.pix_fmt || "",
    hasAlpha: /yuva|rgba|argb|bgra/i.test(v?.pix_fmt || ""),
    duration: Number(info?.format?.duration) || 0,
  };
}

async function ffmpegAvailable() {
  try { await run(BIN.ffmpeg, ["-version"]); return true; } catch { return false; }
}

module.exports = { ffmpeg, probe, mediaDuration, videoInfo, ffmpegAvailable };
