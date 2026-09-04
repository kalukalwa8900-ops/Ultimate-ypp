"use strict";
const { newId } = require("./fsx");

// In-memory job store — good enough for a single local server.
const jobs = new Map();

const STAGES = ["queued", "preparing", "checking", "preparing_vfx", "rendering", "finalizing", "complete", "error"];

function create(projectId, totalPanels) {
  const jobId = newId("job_");
  jobs.set(jobId, {
    jobId,
    projectId,
    status: "queued",
    stage: "queued",
    progress: 0,
    currentPanel: 0,
    totalPanels: totalPanels || 0,
    message: "Queued",
    videoUrl: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  });
  return jobs.get(jobId);
}

function update(jobId, patch) {
  const j = jobs.get(jobId);
  if (!j) return null;
  Object.assign(j, patch);
  if (patch.stage && !patch.status) j.status = patch.stage === "complete" || patch.stage === "error" ? patch.stage : "rendering";
  return j;
}

function get(jobId) {
  return jobs.get(jobId) || null;
}

function fail(jobId, err) {
  return update(jobId, {
    status: "error", stage: "error",
    error: err && err.message ? err.message : String(err),
    message: err && err.message ? err.message : String(err),
    finishedAt: Date.now(),
  });
}

function publicView(j) {
  return {
    jobId: j.jobId,
    projectId: j.projectId,
    status: j.status,
    stage: j.stage,
    progress: Math.max(0, Math.min(100, Math.round(j.progress))),
    currentPanel: j.currentPanel,
    totalPanels: j.totalPanels,
    message: j.message,
    ...(j.videoUrl ? { videoUrl: j.videoUrl } : {}),
    ...(j.error ? { error: j.error } : {}),
  };
}

module.exports = { create, update, get, fail, publicView, STAGES, jobs };
