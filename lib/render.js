"use strict";

const fs = require("fs");
const path = require("path");
const {
  ffmpeg,
  probeDuration,
  motionFilter,
  fitFilter,
  manualCrop,
  transitionSpec,
  DEFAULT_W,
  DEFAULT_H,
} = require("./ffmpeg");

const MIN_DUR = 1.5;

function compressionArgs(meta) {
  const crf = Number(meta.crf) || 26;
  const preset = meta.preset || "medium";
  const maxrate = meta.maxrate || "2500k";
  const bufsize = meta.bufsize || "5000k";
  const ab = meta.audioBitrate || "128k";
  return [
    "-c:v", "libx264",
    "-preset", String(preset),
    "-crf", String(crf),
    "-maxrate", String(maxrate),
    "-bufsize", String(bufsize),
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", String(ab),
    "-ar", "48000",
    "-ac", "2",
  ];
}

async function runFfmpegWithContext(args, ctx = {}, log) {
  try {
    return await ffmpeg(args, { onLog: log, context: ctx });
  } catch (e) {
    // enhance and rethrow with structured info
    const err = new Error(e.message || "ffmpeg failed");
    err.stage = ctx.stage || null;
    err.panelIndex = ctx.panelIndex ?? null;
    err.panelId = ctx.panelId ?? null;
    err.input = ctx.input ?? null;
    err.output = ctx.output ?? null;
    err.command = e.command || e.cmd || null;
    err.stderr = e.stderr || null;
    err.stdout = e.stdout || null;
    err.code = e.code ?? null;
    err.signal = e.signal ?? null;
    throw err;
  }
}

function pushThreadFlags(args, opts) {
  const threads = opts?.threads ?? Number(process.env.FFMPEG_THREADS) || 2;
  const filterThreads = opts?.filterThreads ?? Number(process.env.FFMPEG_FILTER_THREADS) || 1;
  // Insert filter_threads and threads at the start of args so they're global
  if (filterThreads) args.unshift(String(filterThreads), "-filter_threads");
  if (threads) args.unshift(String(threads), "-threads");
  // Note: unshift order above will place -threads then -filter_threads after expansion
  return args;
}

/**
 * Renders one panel into a self-contained MP4 clip.
 * clipDur = narration length (or requested duration) + transition padding, so
 * that the xfade overlap in the concat step does not shift narration timing.
 */
async function renderPanelClip(panel, opts) {
  const { fps, outDir, index, extraTail, fit, log, width, height, breathPadding } = opts;
  const W = Number(width) || DEFAULT_W;
  const H = Number(height) || DEFAULT_H;

  let dur = Number(panel.duration) || 0;
  let audioDur = null;
  if (panel.audioPath && fs.existsSync(panel.audioPath)) {
    audioDur = await probeDuration(panel.audioPath);
    if (audioDur) dur = audioDur + (typeof breathPadding === "number" ? breathPadding : 0);
  }
  if (!Number.isFinite(dur) || dur <= 0) dur = 4;
  dur = Math.max(MIN_DUR, dur);

  const clipDur = dur + (extraTail || 0);

  const args = ["-loop", "1", "-framerate", String(fps), "-t", String(clipDur), "-i", panel.imagePath];
  const inputs = [];
  if (panel.audioPath && fs.existsSync(panel.audioPath)) {
    args.push("-i", panel.audioPath);
    inputs.push({ kind: "narration", idx: args.filter((a) => a === "-i").length - 1 });
  }

  const vfxList = (panel.vfx || []).filter((v) => v.file && fs.existsSync(v.file));
  const sfxList = (panel.sfx || []).filter((s) => s.file && fs.existsSync(s.file));

  let inputIndex = 1 + (panel.audioPath && fs.existsSync(panel.audioPath) ? 1 : 0);
  const vfxIdx = [];
  for (const v of vfxList) {
    // limit VFX input processing to target resolution where possible
    args.push("-stream_loop", "-1", "-t", String(clipDur), "-i", v.file);
    vfxIdx.push(inputIndex++);
  }
  const sfxIdx = [];
  for (const s of sfxList) {
    if (s.loop) args.push("-stream_loop", "-1", "-t", String(clipDur));
    args.push("-i", s.file);
    sfxIdx.push(inputIndex++);
  }

  // ---- video chain ------------------------------------------------------
  const chain = [];
  const crop = manualCrop(panel.zoom, panel.cropX, panel.cropY);
  let pre = `[0:v]${crop ? crop + "," : ""}${fitFilter(fit, W, H)}`;
  chain.push(`${pre}[fit]`);
  chain.push(`[fit]${motionFilter(panel.motion, clipDur, fps, W, H)},format=yuv420p,trim=duration=${clipDur},setpts=PTS-STARTPTS[base]`);

  let vLabel = "base";
  vfxIdx.forEach((idx, i) => {
    const op = Math.max(0, Math.min(1, Number(vfxList[i].opacity ?? 0.6)));
    // scale VFX to target resolution first, preserve alpha (yuva420p), then set opacity
    chain.push(
      `[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuva420p,` +
        `colorchannelmixer=aa=${op.toFixed(3)},trim=duration=${clipDur},setpts=PTS-STARTPTS[vfx${i}]`,
    );
    const out = `vout${i}`;
    chain.push(`[${vLabel}][vfx${i}]overlay=0:0:shortest=0:format=auto[${out}]`);
    vLabel = out;
  });
  chain.push(`[${vLabel}]format=yuv420p[vfinal]`);

  // ---- audio chain ------------------------------------------------------
  const aParts = [];
  if (panel.audioPath && fs.existsSync(panel.audioPath)) {
    chain.push(`[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${clipDur},asetpts=PTS-STARTPTS[nar]`);
    aParts.push("nar");
  }
  sfxIdx.forEach((idx, i) => {
    const vol = Math.max(0, Math.min(4, Number(sfxList[i].volume ?? 0.08)));
    chain.push(
      `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${vol.toFixed(3)},` +
        `apad,atrim=0:${clipDur},asetpts=PTS-STARTPTS[sfx${i}]`,
    );
    aParts.push(`sfx${i}`);
  });

  if (aParts.length === 0) {
    args.push("-f", "lavfi", "-t", String(clipDur), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    chain.push(`[${inputIndex}:a]atrim=0:${clipDur},asetpts=PTS-STARTPTS[afinal]`);
    inputIndex++;
  } else if (aParts.length === 1) {
    chain.push(`[${aParts[0]}]anull[afinal]`);
  } else {
    chain.push(`${aParts.map((l) => `[${l}]`).join("") }amix=inputs=${aParts.length}:duration=longest:dropout_transition=0:normalize=0[afinal]`);
  }

  const out = path.join(outDir, `clip_${String(index).padStart(4, "0")}.mp4`);

  // add filter + thread flags before codec args to limit resource usage
  pushThreadFlags(args, opts);

  args.push(
    "-filter_complex", chain.join(";"),
    "-map", "[vfinal]",
    "-map", "[afinal]",
    "-r", String(fps),
    "-t", String(clipDur),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    out,
  );

  await runFfmpegWithContext(args, { panelIndex: index, panelId: panel.panelId, input: panel.imagePath, output: out, stage: "panel-encode" }, log);
  return { file: out, duration: clipDur, contentDuration: dur };
}

async function concatClips(clips, transitions, finalPath, meta, fps, log, opts = {}) {
  const useXfade = transitions.some((t) => t);
  if (clips.length === 1) {
    try {
      const args = ["-i", clips[0].file, ...compressionArgs(meta), finalPath];
      pushThreadFlags(args, opts);
      await runFfmpegWithContext(args, { stage: "concat", input: clips[0].file, output: finalPath }, log);
      return finalPath;
    } catch (e) {
      throw e;
    }
  }

  if (!useXfade) {
    const listFile = finalPath + ".txt";
    fs.writeFileSync(
      listFile,
      clips.map((c) => `file '${c.file.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    try {
      const args = ["-f", "concat", "-safe", "0", "-i", listFile, ...compressionArgs(meta), finalPath];
      pushThreadFlags(args, opts);
      await runFfmpegWithContext(args, { stage: "concat", input: listFile, output: finalPath }, log);
      return finalPath;
    } catch (e) {
      throw e;
    }
  }

  // For xfade graphs, build as before but still limit threads
  const args = [];
  clips.forEach((c) => args.push("-i", c.file));
  const chain = [];
  let vPrev = "0:v";
  let aPrev = "0:a";
  let offset = clips[0].duration;

  for (let i = 1; i < clips.length; i++) {
    const spec = transitions[i - 1];
    const d = spec ? spec.duration : 0.001;
    const name = spec ? spec.name : "fade";
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    const off = Math.max(0, offset - d);
    chain.push(`[${vPrev}][${i}:v]xfade=transition=${name}:duration=${d}:offset=${off.toFixed(3)}[${vOut}]`);
    chain.push(`[${aPrev}][${i}:a]acrossfade=d=${d}:c1=tri:c2=tri[${aOut}]`);
    vPrev = vOut;
    aPrev = aOut;
    offset = off + clips[i].duration;
  }

  // push thread flags before filter_complex
  pushThreadFlags(args, opts);
  args.push(
    "-filter_complex", chain.join(";"),
    "-map", `[${vPrev}]`,
    "-map", `[${aPrev}]`,
    "-r", String(fps),
    ...compressionArgs(meta),
    finalPath,
  );
  await runFfmpegWithContext(args, { stage: "concat-xfade", input: clips.map((c) => c.file).join(","), output: finalPath }, log);
  return finalPath;
}

async function applyOverlayLogo(input, overlayFile, overlay, output, meta, log, width, height, opts = {}) {
  const W = Number(width) || DEFAULT_W;
  const H = Number(height) || DEFAULT_H;
  const sizePct = Math.max(1, Math.min(50, Number(overlay.sizePct) || 12));
  const opacity = Math.max(0, Math.min(1, Number(overlay.opacity ?? 0.8)));
  const margin = Math.max(0, Number(overlay.marginPx) || 24);
  const pos = String(overlay.position || "bottom-right");
  const x = pos.includes("left") ? `${margin}` : `W-w-${margin}`;
  const y = pos.startsWith("top") ? `${margin}` : `H-h-${margin}`;
  const logoW = Math.round((W * sizePct) / 100);

  try {
    const args = [
      "-i", input,
      "-i", overlayFile,
      "-filter_complex",
      `[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[logo];[0:v][logo]overlay=${x}:${y}[v]`,
      "-map", "[v]",
      "-map", "0:a?",
      ...compressionArgs(meta),
      output,
    ];
    pushThreadFlags(args, opts);
    await runFfmpegWithContext(args, { stage: "overlay", input, output }, log);
    return output;
  } catch (e) {
    throw e;
  }
}

async function normalizeAudio(input, output, meta, log, opts = {}) {
  try {
    const args = ["-i", input, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", ...compressionArgs(meta), output];
    pushThreadFlags(args, opts);
    await runFfmpegWithContext(args, { stage: "normalize", input, output }, log);
    return output;
  } catch (e) {
    throw e;
  }
}

module.exports = { renderPanelClip, concatClips, applyOverlayLogo, normalizeAudio, transitionSpec, compressionArgs };
