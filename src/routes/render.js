"use strict";
const express = require("express");
const { resolveSettings } = require("../config");
const { ensureProject, listFiles, IMAGE_RE, AUDIO_RE, leadingNumber } = require("../lib/fsx");
const jobsStore = require("../lib/jobs");
const { validatePlan, runJob } = require("../render/pipeline");

const router = express.Router();

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

router.post("/render", (req, res) => {
  try {
    const body = req.body || {};
    const projectId = body.projectId || body.project_id;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });

    const paths = ensureProject(projectId);
    const settings = resolveSettings(body.settings);

    let panels = Array.isArray(body.panels) && body.panels.length ? body.panels : autoPanels(paths);
    if (!panels.length) return res.status(400).json({ error: "No panels: upload images and a narration ZIP first" });

    const images = listFiles(paths.images, IMAGE_RE);
    const audio = listFiles(paths.audio, AUDIO_RE);
    const warnings = [];
    if (images.length !== audio.length) {
      warnings.push(`Image count (${images.length}) does not match narration count (${audio.length})`);
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
    // Fire and forget — the HTTP request must not stay open for the render.
    setImmediate(() => runJob(job, check.plan, settings));

    res.json({
      jobId: job.jobId,
      status: "queued",
      stage: "queued",
      totalPanels: check.plan.length,
      settings: {
        resolution: settings.resolution, width: settings.width, height: settings.height, fps: settings.fps,
        vfx_enabled: settings.vfxEnabled, vfx_opacity: settings.vfxOpacity,
        sfx_enabled: settings.sfxEnabled, sfx_volume: settings.sfxVolume,
        filter: settings.filter, motion: "automatic", transitions: "automatic",
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
