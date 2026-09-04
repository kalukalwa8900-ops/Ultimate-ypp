"use strict";
const express = require("express");
const fs = require("fs");
const multer = require("multer");
const { ensureProject, sanitizeName, safeJoin, listFiles, newId, IMAGE_RE, AUDIO_RE, leadingNumber } = require("../lib/fsx");

const router = express.Router();

// Disk storage: image bytes never sit in RAM.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const projectId = sanitizeName(req.body.project_id || req.body.projectId || req.query.project_id || (req._pid ||= newId("p_")));
      req._pid = projectId;
      const paths = ensureProject(projectId);
      cb(null, /audio/i.test(file.fieldname) || AUDIO_RE.test(file.originalname) ? paths.audio : paths.images);
    } catch (e) { cb(e); }
  },
  filename(req, file, cb) {
    cb(null, sanitizeName(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024, files: 5000 },
  fileFilter(req, file, cb) {
    const ok = IMAGE_RE.test(file.originalname) || AUDIO_RE.test(file.originalname);
    cb(ok ? null : new Error(`Unsupported file type: ${file.originalname}`), ok);
  },
});

// Accepts: images / image / files / file (multiple), plus optional audio.
router.post("/panel", upload.any(), (req, res) => {
  const projectId = sanitizeName(req.body.project_id || req.body.projectId || req._pid || newId("p_"));
  const paths = ensureProject(projectId);

  const images = listFiles(paths.images, IMAGE_RE);
  const audio = listFiles(paths.audio, AUDIO_RE);

  const panels = images.map((f, i) => ({
    panel: leadingNumber(f) ?? i + 1,
    image: f,
    audio: audio[i] || null,
  }));

  res.json({
    ok: true,
    projectId,
    uploaded: (req.files || []).length,
    imageCount: images.length,
    audioCount: audio.length,
    panels,
  });
});

// Frees a project's stored files.
router.delete("/panel/:projectId", (req, res) => {
  const paths = ensureProject(req.params.projectId);
  for (const dir of [paths.images, paths.audio]) {
    for (const f of listFiles(dir)) fs.rmSync(safeJoin(dir, f), { force: true });
  }
  res.json({ ok: true, projectId: paths.id });
});

module.exports = router;
