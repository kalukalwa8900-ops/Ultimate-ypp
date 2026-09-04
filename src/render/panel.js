"use strict";
const { ENCODE } = require("../config");
const { ffmpeg } = require("../lib/ffmpeg");
const { imageChain } = require("./motion");
const { fadeChain, audioFadeChain } = require("./transitions");

/**
 * Renders ONE panel segment: image + automatic motion + optional VFX +
 * narration + optional SFX + optional light filter, baked fades included.
 * One ffmpeg process, one output file.
 */
async function renderPanel({
  imagePath, audioPath, duration, motion, inKind, outKind,
  vfx, sfx, settings, outFile, panelNumber,
}) {
  const { width, height, fps } = settings;
  const dur = Math.max(0.2, Number(duration));

  const args = ["-y", "-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", imagePath,
    "-i", audioPath];

  let vfxIdx = -1, sfxIdx = -1;
  let next = 2;
  if (vfx && vfx.path) { args.push("-stream_loop", "-1", "-i", vfx.path); vfxIdx = next++; }
  if (sfx && sfx.path) { args.push("-stream_loop", "-1", "-i", sfx.path); sfxIdx = next++; }

  const chains = [];
  chains.push(`[0:v]${imageChain({ motion, width, height, fps, duration: dur, filterExpr: settings.filterExpr })}[base]`);

  let vLabel = "base";
  if (vfxIdx >= 0) {
    const op = Math.min(1, Math.max(0, settings.vfxOpacity));
    chains.push(`[${vfxIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1[fx]`);
    if (vfx.hasAlpha) {
      // Real alpha channel: straight overlay with opacity.
      chains.push(`[fx]format=yuva420p,colorchannelmixer=aa=${op}[fxa]`);
      chains.push(`[base][fxa]overlay=shortest=1:format=auto[vfxed]`);
    } else {
      // Black-background effect: screen blend keeps the black transparent-ish.
      chains.push(`[base][fx]blend=all_mode=screen:all_opacity=${op}:shortest=1[vfxed]`);
    }
    vLabel = "vfxed";
  }

  const fades = fadeChain({ inKind, outKind, duration: dur });
  const vTail = ["setsar=1", "format=yuv420p"];
  chains.push(`[${vLabel}]${fades ? fades + "," : ""}${vTail.join(",")}[vout]`);

  // ---- audio ----
  const aFades = audioFadeChain({ inKind, outKind, duration: dur });
  chains.push(`[1:a]aresample=${ENCODE.audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad[nar]`);
  let aLabel = "nar";
  if (sfxIdx >= 0) {
    const vol = Math.min(1, Math.max(0, settings.sfxVolume));
    chains.push(`[${sfxIdx}:a]aresample=${ENCODE.audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${vol}[sfxa]`);
    chains.push(`[nar][sfxa]amix=inputs=2:duration=first:normalize=0[mixed]`);
    aLabel = "mixed";
  }
  chains.push(`[${aLabel}]atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS,${aFades}[aout]`);

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", dur.toFixed(3),
    "-r", String(fps),
    "-c:v", "libx264", "-preset", ENCODE.preset, "-crf", String(ENCODE.crf),
    "-pix_fmt", "yuv420p",
    "-g", String(fps * 2), "-keyint_min", String(fps),
    "-c:a", "aac", "-b:a", ENCODE.audioBitrate, "-ar", String(ENCODE.audioRate), "-ac", "2",
    "-movflags", "+faststart",
    outFile,
  );

  await ffmpeg(args, { label: `panel ${panelNumber}` });
  return outFile;
}

module.exports = { renderPanel };
