"use strict";
const fs = require("fs");
const path = require("path");
const { DIRS, SERVER } = require("../config");
const { ensureProject, safeJoin, rmrf, ensureDir } = require("../lib/fsx");
const { ffmpeg, mediaDuration } = require("../lib/ffmpeg");
const jobsStore = require("../lib/jobs");
const { pickMotion } = require("./motion");
const { pickTransition } = require("./transitions");
const { prepareVfxAssets, resolveSfxAssets, findAsset } = require("./assets");
const { renderPanel } = require("./panel");

/**
 * Validates the panel plan BEFORE any ffmpeg work: files present, numbering
 * consistent, referenced VFX/SFX existing.
 * Returns { errors: [], warnings: [], plan: [...] }
 */
function validatePlan(panels, paths, settings) {
  const errors = [];
  const warnings = [];
  const missingImages = [];
  const missingAudio = [];
  const missingVfx = new Set();
  const missingSfx = new Set();
  const plan = [];

  panels.forEach((p, i) => {
    const num = Number(p.panel ?? i + 1);
    const imageFile = p.image ? path.basename(String(p.image)) : null;
    const audioFile = p.audio ? path.basename(String(p.audio)) : null;
    const imagePath = imageFile ? safeJoin(paths.images, imageFile) : null;
    const audioPath = audioFile ? safeJoin(paths.audio, audioFile) : null;

    if (!imagePath || !fs.existsSync(imagePath)) missingImages.push(num);
    if (!audioPath || !fs.existsSync(audioPath)) missingAudio.push(num);

    const vfxName = settings.vfxEnabled ? normalizeName(p.vfx) : null;
    const sfxName = settings.sfxEnabled ? normalizeName(p.sfx) : null;
    if (vfxName && !findAsset("vfx", vfxName)) missingVfx.add(vfxName);
    if (sfxName && !findAsset("sfx", sfxName)) missingSfx.add(sfxName);

    plan.push({ index: i, panel: num, imagePath, audioPath, vfxName, sfxName });
  });

  if (missingImages.length) errors.push(`Missing image for panel(s): ${short(missingImages)}`);
  if (missingAudio.length) errors.push(`Missing narration audio for panel(s): ${short(missingAudio)}`);
  if (missingVfx.size) errors.push(`Missing VFX asset(s): ${[...missingVfx].join(", ")}`);
  if (missingSfx.size) errors.push(`Missing SFX asset(s): ${[...missingSfx].join(", ")}`);

  return { errors, warnings, plan, missingImages, missingAudio, missingVfx: [...missingVfx], missingSfx: [...missingSfx] };
}

function normalizeName(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^(none|no|off|-|n\/a|null)$/i.test(s)) return null;
  return s;
}

function short(list) {
  return list.length > 12 ? `${list.slice(0, 12).join(", ")} … (+${list.length - 12} more)` : list.join(", ");
}

/** Runs the whole render for a job. Never throws — failures land in the job store. */
async function runJob(job, plan, settings) {
  const paths = ensureProject(job.projectId);
  const segDir = ensureDir(safeJoin(paths.tmp, job.jobId));
  const outFile = safeJoin(DIRS.output, `${job.jobId}_final.mp4`);

  try {
    jobsStore.update(job.jobId, { stage: "preparing", status: "rendering", progress: 1, message: "Preparing files" });

    // ---- durations from narration ----
    jobsStore.update(job.jobId, { stage: "checking", progress: 3, message: "Checking images and narration" });
    for (const item of plan) {
      item.duration = await mediaDuration(item.audioPath);
    }

    // ---- unique VFX prepared once ----
    jobsStore.update(job.jobId, { stage: "preparing_vfx", progress: 6, message: "Preparing effects" });
    const vfxMap = settings.vfxEnabled
      ? await prepareVfxAssets(plan.map((p) => p.vfxName), settings, (done, total, name) => {
          jobsStore.update(job.jobId, { message: `Preparing effect ${done}/${total} (${name})`, progress: 6 + (done / Math.max(1, total)) * 6 });
        })
      : new Map();
    const sfxMap = settings.sfxEnabled ? resolveSfxAssets(plan.map((p) => p.sfxName)) : new Map();

    // ---- render panels, one ffmpeg at a time ----
    jobsStore.update(job.jobId, { stage: "rendering", progress: 12, message: "Rendering" });
    const segments = [];
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      const inKind = i === 0 ? "cut" : pickTransition(i - 1);
      const outKind = i === plan.length - 1 ? "cut" : pickTransition(i);
      const seg = safeJoin(segDir, `seg_${String(i + 1).padStart(5, "0")}.mp4`);

      await renderPanel({
        imagePath: item.imagePath,
        audioPath: item.audioPath,
        duration: item.duration,
        motion: pickMotion(i),
        inKind, outKind,
        vfx: item.vfxName ? vfxMap.get(item.vfxName) : null,
        sfx: item.sfxName ? sfxMap.get(item.sfxName) : null,
        settings,
        outFile: seg,
        panelNumber: item.panel,
      });
      segments.push(seg);

      const pct = 12 + ((i + 1) / plan.length) * 80;
      jobsStore.update(job.jobId, {
        stage: "rendering", progress: pct,
        currentPanel: i + 1, totalPanels: plan.length,
        message: `Rendering panel ${i + 1} of ${plan.length}`,
      });
    }

    // ---- final assembly: stream-copy concat (no second full encode) ----
    jobsStore.update(job.jobId, { stage: "finalizing", progress: 93, message: "Finalizing" });
    const listFile = safeJoin(segDir, "concat.txt");
    fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    await ffmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c", "copy", "-movflags", "+faststart", outFile,
    ], { label: "concat" });

    if (!SERVER.keepTemp) rmrf(segDir);

    jobsStore.update(job.jobId, {
      stage: "complete", status: "complete", progress: 100,
      currentPanel: plan.length, totalPanels: plan.length,
      message: "Video ready",
      videoUrl: `${SERVER.publicBase}/output/${path.basename(outFile)}`,
      finishedAt: Date.now(),
    });
  } catch (err) {
    if (!SERVER.keepTemp) rmrf(segDir);
    jobsStore.fail(job.jobId, err);
  }
}

module.exports = { validatePlan, runJob, normalizeName };
