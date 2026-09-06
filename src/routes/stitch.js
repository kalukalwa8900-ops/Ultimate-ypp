"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const { DIRS, SERVER } = require("../config");
const { ensureDir, newId, safeJoin } = require("../lib/fsx");
const { ffmpeg } = require("../lib/ffmpeg");

const router = express.Router();

router.post("/stitch", async (req, res) => {
  const publicBase = process.env.PUBLIC_BASE ? SERVER.publicBase : `https://${req.get("host")}`;
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.map(String).filter(Boolean) : [];
  if (urls.length < 2) return res.status(400).json({ error: "At least 2 video URLs are required" });
  if (urls.some((u) => !/^https?:\/\//i.test(u))) {
    return res.status(400).json({ error: "Only http/https video URLs are supported" });
  }

  const work = safeJoin(DIRS.uploadTmp, newId("stitch_"));
  ensureDir(work);
  try {
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      const r = await fetch(urls[i]);
      if (!r.ok) throw new Error(`Failed to download part ${i + 1}: HTTP ${r.status}`);
      const file = safeJoin(work, `part_${String(i + 1).padStart(4, "0")}.mp4`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      files.push(file);
    }

    const listFile = safeJoin(work, "concat.txt");
    fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const outFile = safeJoin(DIRS.output, `${newId("stitch_")}.mp4`);
    await ffmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c", "copy", "-movflags", "+faststart", outFile,
    ], { label: "stitch" });

    const url = `${publicBase.replace(/\/+$/, "")}/output/${path.basename(outFile)}`;
    res.json({ ok: true, success: true, url, videoUrl: url });
  } catch (err) {
    res.status(500).json({ error: `Stitch failed: ${err.message}` });
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {});
  }
});

module.exports = router;
