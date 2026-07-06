import * as THREE from 'three';
import { BALL_SEAM_TEX_SIZE } from '../config';

// M3.0a §6/§8.7 — volleyball seam texture so the ball's OWN visual spin
// (BallView integrates rotation from launch.omega) actually reads on screen
// instead of a blank sphere looking static while it rotates. Classic
// volleyball/baseball seams are curved lines that vary with BOTH longitude
// (u) AND latitude (v) — that's exactly why they read spin from ANY throw
// axis, not just one. We reuse the same trick: 3 seams, each an S-curve that
// bulges at the equator and pinches at both poles.
//
// Module-lifetime singleton (same pattern as scene/character/faceTextures.ts):
// drawn once into a CanvasTexture, shared by every BallView instance (there is
// only ever one ball, but the pattern is kept for consistency + cheapness),
// and intentionally NEVER disposed — same convention as faceTextures.ts.
let cache: THREE.CanvasTexture | null = null;

const SEAM_COUNT = 3; // evenly spaced curved panel boundaries
const SEAM_BULGE_FRAC = 0.16; // equator bulge as a fraction of texture width
const SEAM_COLOR = '#3a2a10'; // dark seam stroke; multiplies with BALL_COLOR tint
const SEAM_LINE_WIDTH_FRAC = 0.045; // stroke width as a fraction of texture height
const SEAM_CURVE_STEPS = 24; // polyline resolution per seam (visual smoothness only)

export function ballSeamTexture(): THREE.CanvasTexture {
  if (!cache) cache = buildSeamTexture();
  return cache;
}

function buildSeamTexture(): THREE.CanvasTexture {
  const w = BALL_SEAM_TEX_SIZE;
  const h = BALL_SEAM_TEX_SIZE / 2; // equirectangular 2:1 (u∈[0,1] full turn, v∈[0,1] pole-to-pole)
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for ball seam texture');

  // White base so `material.color` (BALL_COLOR) tints the whole ball exactly
  // as it did before this texture existed; seams read as a darker shade of
  // that tint rather than a fixed color baked independently of it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = SEAM_COLOR;
  ctx.lineWidth = h * SEAM_LINE_WIDTH_FRAC;
  ctx.lineCap = 'round';

  for (let k = 0; k < SEAM_COUNT; k++) {
    const baseX = (k / SEAM_COUNT) * w;
    // Draw each seam plus wraparound copies shifted by ±w so the pattern
    // stays continuous across the u=0/u=1 seam (sphere longitude wrap) —
    // canvas drawing doesn't wrap on its own.
    drawSeamCurve(ctx, baseX - w, w, h);
    drawSeamCurve(ctx, baseX, w, h);
    drawSeamCurve(ctx, baseX + w, w, h);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// One S-curve from pole (v=0) to pole (v=1) that bows out sideways by up to
// SEAM_BULGE_FRAC·w at the equator (v=0.5) and pinches back to baseX at both
// poles — the classic volleyball panel-boundary silhouette.
function drawSeamCurve(ctx: CanvasRenderingContext2D, baseX: number, w: number, h: number): void {
  ctx.beginPath();
  for (let i = 0; i <= SEAM_CURVE_STEPS; i++) {
    const v = i / SEAM_CURVE_STEPS;
    const x = baseX + Math.sin(v * Math.PI) * SEAM_BULGE_FRAC * w;
    const y = v * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
