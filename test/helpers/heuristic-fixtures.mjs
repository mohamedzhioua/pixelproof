/**
 * Procedural image fixtures for the heuristic tier.
 *
 * Generated into a temporary directory rather than committed, so the suite
 * carries no binaries and the content of each fixture is readable as code. The
 * shapes are deliberately structured (edges, flat regions, a colour accent)
 * rather than smooth noise: a DCT hash of pure noise is dominated by whichever
 * coefficients happen to land near the median, which would make every property
 * assertion here a coin toss rather than a test.
 */

import path from 'node:path';

import { writePng } from './compat-harness.mjs';

export const FIXTURE_EDGE = 512;

function inCircle(x, y, cx, cy, radius) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** A layout with two blobs, a colour band, and a light background. */
export function structuredScene(edge = FIXTURE_EDGE) {
  return (x, y) => {
    const u = x / edge;
    const v = y / edge;
    if (v > 0.78) return [220, 40, 60, 255];
    if (inCircle(u, v, 0.32, 0.34, 0.19)) return [30, 30, 40, 255];
    if (inCircle(u, v, 0.72, 0.55, 0.12)) return [40, 120, 200, 255];
    if (Math.abs(u - v) < 0.03) return [90, 90, 90, 255];
    return [242, 242, 240, 255];
  };
}

/** An unrelated layout: horizontal bands of varying width and lightness. */
export function stripedScene(edge = FIXTURE_EDGE) {
  return (x, y) => {
    const band = Math.floor((y / edge) * 7);
    const shade = [20, 210, 60, 180, 100, 240, 140][band % 7];
    if ((x / edge) > 0.85) return [10, 160, 90, 255];
    return [shade, shade, Math.min(255, shade + 15), 255];
  };
}

/** A third unrelated layout: concentric rings. */
export function ringScene(edge = FIXTURE_EDGE) {
  return (x, y) => {
    const u = x / edge - 0.5;
    const v = y / edge - 0.5;
    const radius = Math.hypot(u, v);
    const ring = Math.floor(radius * 12) % 2;
    return ring === 0 ? [235, 225, 200, 255] : [60, 50, 90, 255];
  };
}

/** A solid frame, optionally with a single small mark. */
export function blankScene(color, mark = null, edge = FIXTURE_EDGE) {
  return (x, y) => {
    if (mark && inCircle(x / edge, y / edge, mark.x, mark.y, mark.radius)) return mark.color;
    return color;
  };
}

export async function writeScene(root, name, pixel, { edge = FIXTURE_EDGE } = {}) {
  const filePath = path.join(root, name);
  await writePng(filePath, edge, edge, { pixel });
  return filePath;
}
