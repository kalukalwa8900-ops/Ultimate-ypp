"use strict";
const express = require("express");
const path = require("path");
const multer = require("multer");
const { resolveSettings, SERVER } = require("../config");
const { ensureProject, listFiles, IMAGE_RE, AUDIO_RE, leadingNumber } = require("../lib/fsx");
const jobsStore = require("../lib/jobs");
const { validatePlan, runJob } = require("../render/pipeline");

const router = express.Router();

// The frontend switches to multipart/form-data (with a "payload" field
// holding the JSON body) whenever a logo overlay is attached, so it can send
// the logo image alongside the render request. express.json() only parses
// application/json bodies — for multipart requests req.body was silently
// {} and every overlay render failed instantly with "projectId is required".
// multer.any() only touches multipart requests; plain JSON POSTs pass
// through untouched, so this is safe to attach unconditionally. Uploaded overlay
// bytes are stored on disk so large multipart requests do not consume RAM.
const overlayUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, require("../lib/fsx").ensureDir(require("../config").DIRS.uploadTmp)),
    filename: (req, file, cb) => cb(null, `${require("../lib/fsx").newId("overlay_")}_${require("../lib/fsx").sanitizeName(file.originalname)}`),
  }),
});

/** Builds the request body regardless of whether it arrived as JSON or multipart+payload. */
function parseBody(req) {
  if (req.body && typeof req.body.payload === "string") {
    try { return JSON.parse(req.body.payload); } catch { /* fall through */ }
  }
  return req.body || {};
}

function cleanupUploadedFiles(files) {
  for (const file of files || []) {
    if (file && file.path) {
      try { require("fs").rmSync(file.path, { force: true }); } catch { /* ignore cleanup errors */ }
    }
  }
}

/** Public HTTPS host used by the deployment proxy (Railway, etc.). */
function publicBaseFor(req) {
  if (process.env.PUBLIC_BASE) return SERVER.publicBase;
  return `https://${req.get("host")}`;
}

/** Builds panels from the project directory when the client sends none. */
function autoPanels(paths) {
  const images = listFiles(paths.images, IMAGE_RE);
  const audio = listFiles(paths.audio, AUDIO_RE);
  return images.map((img, i) => ({
    panel: leadingNumber(img) ?? i + 1,
    image: img,
    audio: audio[i] || null,
    vfx: null,
    sfx: null,
  }));
}

/** Resolves a client's partial panel objects against files already uploaded. */
function resolvePanelFiles(panels, paths) {
  const images = listFiles(paths.images, IMAGE_RE);
  const audio = listFiles(paths.audio, AUDIO_RE);
  const imageByName = new Map(images.map((f) => [f.toLowerCase(), f]));
  const audioByNumber = new Map();
  for (const f of audio) {
    const n = leadingNumber(f);
    if (n !== null && !audioByNumber.has(n)) audioByNumber.set(n, f);
  }
  return panels.map((p, i) => {
    const panelNo = Number(p.panel ?? p.index ?? i + 1);
    const ref = p.ref || p.panel_id || p.panelId || null;
    const requestedImage = p.image || (ref ? `${String(ref).replace(/\.(png|jpe?g|webp|bmp)$/i, "")}.jpg` : null);
    const image = requestedImage && imageByName.has(path.basename(String(requestedImage)).toLowerCase())
      ? imageByName.get(path.basename(String(requestedImage)).toLowerCase())
      : (images[i] || null);
    const requestedAudio = p.audio ? path.basename(String(p.audio)) : null;
    const audioFile = requestedAudio && audio.some((f) => f.toLowerCase() === requestedAudio.toLowerCase())
      ? audio.find((f) => f.toLowerCase() === requestedAudio.toLowerCase())
      : (audioByNumber.get(panelNo) || audio[i] || null);
    return { ...p, panel: Number.isFinite(panelNo) ? panelNo : i + 1, image, audio: audioFile };
  });
}

router.post("/render", overlayUpload.any(), (req, res) => {
  res.on("finish", () => cleanupUploadedFiles(req.files));
  try {
    const body = parseBody(req);
    const projectId = body.projectId || body.project_id;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });

    const paths = ensureProject(projectId);
    const settings = resolveSettings(body.settings || body);

    let panels = Array.isArray(body.panels) && body.panels.length ? resolvePanelFiles(body.panels, paths) : autoPanels(paths);
    if (!panels.length) return res.status(400).json({ error: "No panels: upload images and a narration ZIP first" });

    const images = listFiles(paths.images, IMAGE_RE);
    const audio = listFiles(paths.audio, AUDIO_RE);
    const warnings = [];
    if (images.length !== audio.length) {
      warnings.push(`Image count (${images.length}) does not match narration count (${audio.length})`);
    }
    const overlayFile = (req.files || []).find((f) => ["overlay", "overlayLogo", "watermark"].includes(f.fieldname));
    if (overlayFile) {
      // The upload itself now works, but no server-side compositing step
      // consumes it yet (see render/panel.js) — flag it so it's obvious in
      // the response rather than a silently-missing watermark.
      warnings.push("Logo overlay was received but watermark compositing isn't implemented on this backend yet — it will not appear in the video.");
    }

    const check = validatePlan(panels, paths, settings);
    if (check.errors.length) {
      return res.status(400).json({
        error: check.errors.join(" · "),
        errors: check.errors,
        missingImages: check.missingImages,
        missingAudio: check.missingAudio,
        missingVfx: check.missingVfx,
        missingSfx: check.missingSfx,
        warnings,
      });
    }

    const job = jobsStore.create(paths.id, check.plan.length);
    const publicBase = publicBaseFor(req);
    // Fire and forget — the HTTP request must not stay open for the render.
    setImmediate(() => runJob(job, check.plan, settings, publicBase));

    res.json({
      jobId: job.jobId,
      status: "queued",
      stage: "queued",
      totalPanels: check.plan.length,
      settings: {
        resolution: settings.resolution, width: settings.width, height: settings.height, fps: settings.fps,
        vfx_enabled: settings.vfxEnabled, vfx_opacity: settings.vfxOpacity, vfx_blend_mode: settings.vfxBlendMode,
        sfx_enabled: settings.sfxEnabled, sfx_volume: settings.sfxVolume,
        motion: "automatic", transitions: "automatic",
      },
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/status/:jobId", (req, res) => {
  const job = jobsStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown jobId" });
  res.json(jobsStore.publicView(job));
});

module.exports = router;
