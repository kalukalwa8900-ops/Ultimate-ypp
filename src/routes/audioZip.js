"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const unzipper = require("unzipper");
const { ensureProject, sanitizeName, safeJoin, listFiles, newId, leadingNumber, naturalSort, AUDIO_RE, ensureDir } = require("../lib/fsx");
const { DIRS } = require("../config");

const router = express.Router();

const upload = multer({
  dest: ensureDir(DIRS.uploadTmp),
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ensureDir(DIRS.uploadTmp)),
    filename: (req, file, cb) => cb(null, `${newId("zip_")}.zip`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

/** Streams the ZIP from disk and writes only MP3-ish entries into the project. */
async function extractAudioZip(zipPath, audioDir) {
  const files = [];
  const warnings = [];
  const seen = new Map();

  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.type === "Directory") continue;
    const raw = entry.path.replace(/\\/g, "/");
    if (raw.includes("../") || raw.startsWith("/")) { warnings.push(`Skipped unsafe path: ${raw}`); continue; }
    const base = raw.split("/").pop();
    if (!base || base.startsWith("._") || raw.includes("__MACOSX")) continue;
    if (!AUDIO_RE.test(base)) continue;

    const safeName = sanitizeName(base);
    const n = leadingNumber(safeName);
    if (n === null) { warnings.push(`Ignored non-numbered audio file: ${base}`); continue; }
    if (seen.has(n)) { warnings.push(`Duplicate numbering ${n}: kept ${seen.get(n)}, ignored ${base}`); continue; }

    const target = safeJoin(audioDir, `${n}${path.extname(safeName).toLowerCase()}`);
    await new Promise((resolve, reject) => {
      entry.stream()
        .pipe(fs.createWriteStream(target))
        .on("finish", resolve)
        .on("error", reject);
    });
    seen.set(n, path.basename(target));
    files.push({ panel: n, file: path.basename(target) });
  }
  return { files: files.sort((a, b) => a.panel - b.panel), warnings };
}

router.post("/audio-zip", upload.single("audioZip"), async (req, res) => {
  const zipPath = req.file && req.file.path;
  try {
    if (!zipPath) return res.status(400).json({ error: "No ZIP uploaded (field name must be 'audioZip')" });
    const projectId = sanitizeName(req.body.project_id || req.body.projectId || newId("p_"));
    const paths = ensureProject(projectId);

    const { files, warnings } = await extractAudioZip(zipPath, paths.audio);
    if (!files.length) {
      return res.status(400).json({ error: "No numbered MP3 files found in ZIP", warnings });
    }

    // Missing numbers relative to the highest number present.
    const max = files[files.length - 1].panel;
    const have = new Set(files.map((f) => f.panel));
    const missing = [];
    for (let i = 1; i <= max; i++) if (!have.has(i)) missing.push(i);

    res.json({
      ok: true,
      projectId,
      audioCount: files.length,
      files: naturalSort(files.map((f) => f.file)),
      attached: files,
      missing,
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: `ZIP extraction failed: ${err.message}` });
  } finally {
    if (zipPath) fs.rm(zipPath, { force: true }, () => {});
  }
});

router.get("/audio/:projectId", (req, res) => {
  const paths = ensureProject(req.params.projectId);
  res.json({ projectId: paths.id, files: listFiles(paths.audio, AUDIO_RE) });
});

module.exports = router;
