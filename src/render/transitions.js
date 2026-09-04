"use strict";
const CONFIG = require("../../motion.config.json");

// Automatic transitions. Deliberately cheap: the fade is baked into the single
// panel encode (fade out on the outgoing panel, fade in on the incoming one),
// so the final assembly is a stream-copy concat. No second full-video encode.
const CYCLE = CONFIG.transitionCycle && CONFIG.transitionCycle.length
  ? CONFIG.transitionCycle
  : ["cut", "dissolve", "cut", "fade_black"];

function pickTransition(index0) {
  return CYCLE[(index0 * 3 + 1) % CYCLE.length];
}

/** Seconds of fade used at a boundary (0 for a hard cut). */
function boundaryFade(kind, panelDuration, base) {
  if (!kind || kind === "cut") return 0;
  const t = kind === "fade_black" ? base : base * 0.6;
  return Math.max(0, Math.min(t, panelDuration / 3));
}

/**
 * fade filters for one panel, given the transition into it and out of it.
 * Returns "" when both boundaries are hard cuts.
 */
function fadeChain({ inKind, outKind, duration, base = CONFIG.transitionSeconds || 0.5 }) {
  const fin = boundaryFade(inKind, duration, base);
  const fout = boundaryFade(outKind, duration, base);
  const parts = [];
  if (fin > 0) parts.push(`fade=t=in:st=0:d=${fin.toFixed(3)}`);
  if (fout > 0) parts.push(`fade=t=out:st=${(duration - fout).toFixed(3)}:d=${fout.toFixed(3)}`);
  return parts.join(",");
}

/** Matching short audio fades so cuts never click. */
function audioFadeChain({ inKind, outKind, duration, base = CONFIG.transitionSeconds || 0.5 }) {
  const fin = Math.min(0.08, boundaryFade(inKind, duration, base) || 0.05);
  const fout = Math.min(0.12, boundaryFade(outKind, duration, base) || 0.05);
  return [
    `afade=t=in:st=0:d=${fin.toFixed(3)}`,
    `afade=t=out:st=${Math.max(0, duration - fout).toFixed(3)}:d=${fout.toFixed(3)}`,
  ].join(",");
}

module.exports = { pickTransition, fadeChain, audioFadeChain, CYCLE };
