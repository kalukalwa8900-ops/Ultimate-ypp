"use strict";
const express = require("express");
const multer = require("multer");
const { DIRS } = require("../config");
const { sanitizeName, VIDEO_RE, AUDIO_RE } = require("../lib/fsx");
const { listLibrary } = require("../render/assets");

const router = express.Router();

function uploader(kind) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, kind === "vfx" ? DIRS.vfx : DIRS.sfx),
      filename: (req, file, cb) => cb(null, sanitizeName(req.body.name ? `${req.body.name}${require("path").extname(file.originalname)}` : file.originalname)),
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter(req, file, cb) {
      const ok = kind === "vfx" ? VIDEO_RE.test(file.originalname) : AUDIO_RE.test(file.originalname);
      cb(ok ? null : new Error(`Unsupported ${kind} file: ${file.originalname}`), ok);
    },
  });
}

router.get("/assets", (req, res) => {
  res.json({ vfx: listLibrary("vfx"), sfx: listLibrary("sfx") });
});

router.post("/assets/vfx", uploader("vfx").any(), (req, res) => {
  res.json({ ok: true, added: (req.files || []).map((f) => f.filename), vfx: listLibrary("vfx") });
});

router.post("/assets/sfx", uploader("sfx").any(), (req, res) => {
  res.json({ ok: true, added: (req.files || []).map((f) => f.filename), sfx: listLibrary("sfx") });
});

module.exports = router;
