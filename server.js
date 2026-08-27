"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { ffmpeg } = require("./lib/ffmpeg");
const { transitionSpec } = require("./lib/ffmpeg");
const {
  renderPanelClip,
  concatClips,
  applyOverlayLogo,
  normalizeAudio,
} = require("./lib/render");

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "render-data");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const OUT_DIR = path.join(DATA_DIR, "out");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const RETENTION_MIN = Number(process.env.RETENTION_MIN) || 240;

for (const d of [DATA_DIR, PROJECTS_DIR, OUT_DIR]) fs.mkdirSync(d, { recursive: true });

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "64mb" }));
app.use(express.urlencoded({ extended: true, limit: "64mb" }));

const upload = multer({
  dest: path.join(DATA_DIR, "uploads"),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const jobs = new Map();

function safeId(v, fallback) {
  const s = String(v || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return s || fallback;
}

function projectDir(projectId) {
  const dir = path.join(PROJECTS_DIR, safeId(projectId, "unknown"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function panelMetaPath(projectId, panelId) {
  return path.join(projectDir(projectId), `${safeId(panelId, "panel")}.json`);
}

function readPanel(projectId, panelId) {
  const p = panelMetaPath(projectId, panelId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writePanel(projectId, panelId, meta) {
  fs.writeFileSync(panelMetaPath(projectId, panelId), JSON.stringify(meta, null, 2));
}

function jsonField(body, key) {
  const raw = body[key];
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function publicUrl(req, filename) {
  const base =
    process.env.PUBLIC_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`;
  return `${String(base).replace(/\/+$/, "")}/files/${filename}`;
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} -> http ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return dest;
}

function extOf(name, fallback) {
  const e = path.extname(String(name || "")).toLowerCase();
  return e && e.length <= 5 ? e : fallback;
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.json({ ok: true, service: "slideshow-render-backend" }));
app.get("/health", (_req, res) => res.json({ ok: true, jobs: jobs.size }));

app.use(
  "/files",
  express.static(OUT_DIR, {
    setHeaders: (res) => res.setHeader("Access-Control-Allow-Origin", "*"),
  }),
);

// ---------------------------------------------------------------------------
// POST /panel  — one panel (image + optional narration + cinematic assets)
// ---------------------------------------------------------------------------
app.post("/panel", upload.any(), async (req, res) => {
  try {
    const files = req.files || [];
    const body = req.body || {};
    const projectId = safeId(body.project_id, "p_default");
    const index = Number(body.index) || 0;
    const panelId = safeId(body.panel_id, `panel_${String(index + 1).padStart(4, "0")}`);
    const dir = path.join(projectDir(projectId), panelId);
    fs.mkdirSync(dir, { recursive: true });

    const pick = (name) => files.find((f) => f.fieldname === name);

    const image = pick("image") || files.find((f) => (f.mimetype || "").startsWith("image/"));
    if (!image) return res.status(400).json({ success: false, error: "missing image" });

    const imagePath = path.join(dir, `image${extOf(image.originalname, ".jpg")}`);
    await fsp.rename(image.path, imagePath);

    let audioPath = null;
    const audio = pick("audio");
    if (audio) {
      audioPath = path.join(dir, `audio${extOf(audio.originalname, ".mp3")}`);
      await fsp.rename(audio.path, audioPath);
    }

    // ---- cinematic assets -------------------------------------------------
    const cine = jsonField(body, "cinematic") || {};
    const vfxMeta = jsonField(body, "vfx") || cine.vfx || [];
    const sfxMeta = jsonField(body, "sfx") || cine.sfx || [];

    const resolveAssets = async (list, kind, defExt) => {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const m = list[i] || {};
        const field = m.file || `${kind}_${i}`;
        const uploaded = pick(field);
        let file = null;
        if (uploaded) {
          file = path.join(dir, `${kind}_${i}${extOf(uploaded.originalname, defExt)}`);
          await fsp.rename(uploaded.path, file);
        } else {
          const url = m.url || body[`${kind}_${i}_url`];
          if (url) {
            try {
              file = path.join(dir, `${kind}_${i}${extOf(url, defExt)}`);
              await download(url, file);
            } catch (e) {
              file = null;
              console.warn(`[panel] ${kind} download failed:`, e.message);
            }
          }
        }
        if (!file) continue;
        out.push({
          name: m.name || `${kind}_${i}`,
          file,
          opacity: m.opacity,
          volume: m.volume,
          loop: !!m.loop,
        });
      }
      return out;
    };

    const vfx = await resolveAssets(Array.isArray(vfxMeta) ? vfxMeta : [], "vfx", ".mp4");
    const sfx = await resolveAssets(Array.isArray(sfxMeta) ? sfxMeta : [], "sfx", ".mp3");

    // drop any leftover temp uploads
    for (const f of files) {
      if (fs.existsSync(f.path)) await fsp.unlink(f.path).catch(() => {});
    }

    const meta = {
      projectId,
      panelId,
      index,
      imagePath,
      audioPath,
      duration: Number(body.duration) || 4,
      zoom: Number(body.zoom) || 1,
      cropX: Number(body.cropX ?? 50),
      cropY: Number(body.cropY ?? 50),
      motion: body.motion || cine.motion || "Static",
      transition: body.transition || cine.transition || "Hard Cut",
      fit: body.outputFit || body.fit || "cover",
      fps: Number(body.fps) || 20,
      narration: body.processedText || body.narration || "",
      vfx,
      sfx,
      updatedAt: Date.now(),
    };
    writePanel(projectId, panelId, meta);

    res.json({ success: true, panel_id: panelId, index });
  } catch (e) {
    console.error("[/panel]", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /audio-zip — attach MP3s from a ZIP to the project's panels in order
// ---------------------------------------------------------------------------
app.post("/audio-zip", upload.any(), async (req, res) => {
  try {
    const files = req.files || [];
    const zipFile = files.find((f) => f.fieldname === "audioZip") || files[0];
    if (!zipFile) return res.status(400).json({ error: "missing audioZip" });
    const projectId = safeId(req.body.project_id, "p_default");
    const dir = projectDir(projectId);

    const zip = new AdmZip(zipFile.path);
    const entries = zip
      .getEntries()
      .filter((e) => !e.isDirectory && /\.(mp3|wav|m4a|aac|ogg)$/i.test(e.entryName))
      .filter((e) => !path.basename(e.entryName).startsWith("._"))
      .sort((a, b) => naturalCompare(path.basename(a.entryName), path.basename(b.entryName)));

    const panelFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
      .sort((a, b) => a.index - b.index);

    const audioDir = path.join(dir, "_audio");
    fs.mkdirSync(audioDir, { recursive: true });

    const attached = [];
    const warnings = [];
    const used = new Set();

    // 1st pass — match by a number inside the filename (panel number)
    for (const entry of entries) {
      const base = path.basename(entry.entryName);
      const m = base.match(/(\d+)/g);
      if (!m) continue;
      const n = Number(m[m.length - 1]);
      const panel = panelFiles.find((p) => p.index + 1 === n);
      if (!panel || used.has(panel.panelId)) continue;
      const dest = path.join(audioDir, `${panel.panelId}${extOf(base, ".mp3")}`);
      fs.writeFileSync(dest, entry.getData());
      panel.audioPath = dest;
      writePanel(projectId, panel.panelId, panel);
      used.add(panel.panelId);
      attached.push({ panel: panel.index + 1, file: base });
      entry.__used = true;
    }

    // 2nd pass — sequential fallback for whatever is left
    const remainingEntries = entries.filter((e) => !e.__used);
    const remainingPanels = panelFiles.filter((p) => !used.has(p.panelId));
    for (let i = 0; i < Math.min(remainingEntries.length, remainingPanels.length); i++) {
      const entry = remainingEntries[i];
      const panel = remainingPanels[i];
      const base = path.basename(entry.entryName);
      const dest = path.join(audioDir, `${panel.panelId}${extOf(base, ".mp3")}`);
      fs.writeFileSync(dest, entry.getData());
      panel.audioPath = dest;
      writePanel(projectId, panel.panelId, panel);
      used.add(panel.panelId);
      attached.push({ panel: panel.index + 1, file: base });
    }

    const missing = panelFiles.filter((p) => !p.audioPath).map((p) => p.index + 1);
    if (entries.length > panelFiles.length) {
      warnings.push(`${entries.length} audio files for ${panelFiles.length} panels — extras ignored.`);
    }

    await fsp.unlink(zipFile.path).catch(() => {});
    res.json({ success: true, attached, missing, warnings, total: entries.length });
  } catch (e) {
    console.error("[/audio-zip]", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /render — accepts JSON body or multipart (payload + overlay logo)
// ---------------------------------------------------------------------------
app.post("/render", upload.any(), async (req, res) => {
  try {
    let body = req.body || {};
    const payload = jsonField(body, "payload");
    if (payload) body = { ...body, ...payload };
    if (typeof body.panels === "string") body.panels = jsonField(body, "panels") || [];
    if (typeof body.overlay === "string") body.overlay = jsonField(body, "overlay") || { enabled: false };

    const projectId = safeId(body.project_id, "");
    if (!projectId) return res.status(400).json({ error: "missing project_id" });

    const refs = Array.isArray(body.panels)
      ? body.panels.map((p) => (typeof p === "string" ? p : p.ref || p.panel_id)).filter(Boolean)
      : [];
    if (!refs.length) return res.status(400).json({ error: "no panels" });

    const files = req.files || [];
    const logo = files.find((f) => ["overlay", "overlayLogo", "watermark"].includes(f.fieldname));
    let overlayLogoPath = null;
    if (logo) {
      overlayLogoPath = path.join(projectDir(projectId), `overlay${extOf(logo.originalname, ".png")}`);
      await fsp.rename(logo.path, overlayLogoPath);
    }
    for (const f of files) if (fs.existsSync(f.path)) await fsp.unlink(f.path).catch(() => {});

    const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    jobs.set(jobId, { jobId, status: "queued", progress: 0, createdAt: Date.now() });

    const opts = {
      projectId,
      refs,
      fps: Number(body.fps || body.frameRate || body.frame_rate) || 20,
      fit: body.outputFit || body.fit || "cover",
      audioNormalize: String(body.audioNormalize ?? body.audio_normalize ?? "true") !== "false",
      compression: {
        crf: body.crf,
        preset: body.preset,
        maxrate: body.maxrate,
        bufsize: body.bufsize,
        audioBitrate: body.audioBitrate,
      },
      overlay: body.overlay && body.overlay.enabled ? body.overlay : null,
      overlayLogoPath,
      publicBase: publicUrl(req, "").replace(/\/files\/$/, ""),
      req,
    };

    runJob(jobId, opts).catch((e) => {
      console.error("[job]", jobId, e);
      jobs.set(jobId, { jobId, status: "error", progress: 0, error: e.message });
    });

    res.json({ jobId, success: true });
  } catch (e) {
    console.error("[/render]", e);
    res.status(500).json({ error: e.message });
  }
});

async function runJob(jobId, opts) {
  const set = (patch) => jobs.set(jobId, { ...(jobs.get(jobId) || { jobId }), ...patch });
  set({ status: "rendering", progress: 1 });

  const workDir = path.join(DATA_DIR, "work", jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const panels = opts.refs
    .map((ref) => readPanel(opts.projectId, ref))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
  if (!panels.length) throw new Error("panels not found for this project");

  const transitions = [];
  for (let i = 0; i < panels.length - 1; i++) transitions.push(transitionSpec(panels[i + 1].transition));

  const clips = [];
  for (let i = 0; i < panels.length; i++) {
    const tail = transitions[i] ? transitions[i].duration : 0;
    const clip = await renderPanelClip(panels[i], {
      fps: opts.fps,
      outDir: workDir,
      index: i,
      extraTail: tail,
      fit: panels[i].fit || opts.fit,
    });
    clips.push(clip);
    set({ status: "rendering", progress: Math.round(((i + 1) / panels.length) * 75) });
  }

  set({ status: "rendering", progress: 80 });
  let current = path.join(workDir, "joined.mp4");
  await concatClips(clips, transitions, current, opts.compression, opts.fps);

  if (opts.overlay && opts.overlayLogoPath && fs.existsSync(opts.overlayLogoPath)) {
    set({ progress: 88 });
    const withLogo = path.join(workDir, "logo.mp4");
    await applyOverlayLogo(current, opts.overlayLogoPath, opts.overlay, withLogo, opts.compression);
    current = withLogo;
  }

  if (opts.audioNormalize) {
    set({ progress: 93 });
    const normalized = path.join(workDir, "norm.mp4");
    try {
      await normalizeAudio(current, normalized, opts.compression);
      current = normalized;
    } catch (e) {
      console.warn("[job] loudnorm failed, keeping raw audio:", e.message);
    }
  }

  const outName = `${jobId}.mp4`;
  const outPath = path.join(OUT_DIR, outName);
  await fsp.copyFile(current, outPath);
  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

  const url = `${opts.publicBase}/files/${outName}`;
  set({ status: "done", progress: 100, url, video_url: url, videoUrl: url, file: outName });
}

// ---------------------------------------------------------------------------
// GET /status/:jobId
// ---------------------------------------------------------------------------
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "error", error: "unknown job" });
  res.json(job);
});

// ---------------------------------------------------------------------------
// POST /stitch — concatenate finished part URLs into one MP4 (stream copy)
// ---------------------------------------------------------------------------
app.post("/stitch", async (req, res) => {
  try {
    const urls = Array.isArray(req.body.urls) ? req.body.urls.filter(Boolean) : [];
    if (!urls.length) return res.status(400).json({ error: "no urls" });
    if (urls.length === 1) return res.json({ url: urls[0] });

    const id = `stitch_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    const workDir = path.join(DATA_DIR, "work", id);
    fs.mkdirSync(workDir, { recursive: true });

    const parts = [];
    for (let i = 0; i < urls.length; i++) {
      const p = path.join(workDir, `part_${String(i).padStart(3, "0")}.mp4`);
      await download(urls[i], p);
      parts.push(p);
    }

    const listFile = path.join(workDir, "list.txt");
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

    const outName = `${id}.mp4`;
    const outPath = path.join(OUT_DIR, outName);
    try {
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", outPath]);
    } catch (e) {
      console.warn("[stitch] copy failed, re-encoding:", e.message);
      await ffmpeg([
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", outPath,
      ]);
    }

    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    res.json({ url: publicUrl(req, outName), success: true });
  } catch (e) {
    console.error("[/stitch]", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// cleanup — remove old outputs / project scratch data
// ---------------------------------------------------------------------------
setInterval(() => {
  const cutoff = Date.now() - RETENTION_MIN * 60 * 1000;
  for (const dir of [OUT_DIR, PROJECTS_DIR, path.join(DATA_DIR, "work"), path.join(DATA_DIR, "uploads")]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }
  for (const [id, job] of jobs) if ((job.createdAt || 0) < cutoff) jobs.delete(id);
}, 15 * 60 * 1000).unref?.();

app.use((err, _req, res, _next) => {
  console.error("[error]", err);
  res.status(err.status || 500).json({ error: err.message || "server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`render backend listening on :${PORT} (data: ${DATA_DIR})`);
});
