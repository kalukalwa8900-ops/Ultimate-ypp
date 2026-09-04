"use strict";
const CONFIG = require("../../motion.config.json");

// Automatic motion. ~60% zoom style, ~40% pan/push/pull — deterministic per panel
// so the same project always renders the same way.
const ZOOM = ["zoom_in", "zoom_out", "push_in", "pull_back"];
const PAN = ["pan_left", "pan_right", "pan_up", "pan_down"];

function pickMotion(index0) {
  // Cheap deterministic hash keeps the 60/40 split without long repeats.
  const h = (index0 * 2654435761) % 100;
  if (h < (CONFIG.zoomShare ?? 60)) return ZOOM[(index0 * 3 + 1) % ZOOM.length];
  return PAN[(index0 * 5 + 2) % PAN.length];
}

/**
 * Builds the image filter chain for one panel:
 * scale (cover) -> zoompan motion -> optional look filter -> fps/format.
 * Every value comes from the resolved settings — nothing hardcoded.
 */
function imageChain({ motion, width, height, fps, duration, filterExpr }) {
  const frames = Math.max(1, Math.round(duration * fps));
  const SW = width * 2, SH = height * 2; // oversample so zoompan stays sharp
  const zMax = CONFIG.zoomAmount ?? 1.12;
  const step = `(${zMax}-1)/${frames}`;

  let z, x, y;
  const cx = `iw/2-(iw/zoom/2)`;
  const cy = `ih/2-(ih/zoom/2)`;

  switch (motion) {
    case "zoom_in":
    case "push_in":
      z = `min(1+${step}*on,${zMax})`; x = cx; y = cy; break;
    case "zoom_out":
    case "pull_back":
      z = `max(${zMax}-${step}*on,1)`; x = cx; y = cy; break;
    case "pan_left":
      z = `${(1 + (zMax - 1) / 2).toFixed(4)}`;
      x = `(iw-iw/zoom)*(1-on/${frames})`; y = cy; break;
    case "pan_right":
      z = `${(1 + (zMax - 1) / 2).toFixed(4)}`;
      x = `(iw-iw/zoom)*(on/${frames})`; y = cy; break;
    case "pan_up":
      z = `${(1 + (zMax - 1) / 2).toFixed(4)}`;
      x = cx; y = `(ih-ih/zoom)*(1-on/${frames})`; break;
    case "pan_down":
    default:
      z = `${(1 + (zMax - 1) / 2).toFixed(4)}`;
      x = cx; y = `(ih-ih/zoom)*(on/${frames})`; break;
  }

  const parts = [
    `scale=${SW}:${SH}:force_original_aspect_ratio=increase`,
    `crop=${SW}:${SH}`,
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${fps}`,
    `trim=duration=${duration.toFixed(3)}`,
    `setpts=PTS-STARTPTS`,
  ];
  if (filterExpr) parts.push(filterExpr);
  parts.push("setsar=1", "format=yuv420p");
  return parts.join(",");
}

module.exports = { pickMotion, imageChain, ZOOM, PAN };
