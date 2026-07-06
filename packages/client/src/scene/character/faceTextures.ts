import * as THREE from 'three';
import { FACE_TEX_SIZE, HEAD_COLOR } from './characterConstants';

// M2.5 §2 — three cartoon faces drawn once into CanvasTextures (normal / happy
// / dazed), swapped on the head material to react to PERFECT / WHIFF·dive_fail.
// Cheap + high 笑果: no per-frame drawing, just a map swap.
export type FaceExpression = 'normal' | 'happy' | 'dazed';

// One shared, immutable set of textures for EVERY character — faces never
// differ per player, so building them once avoids N canvas allocations and the
// textures are never disposed (module-lifetime singletons).
let cache: Record<FaceExpression, THREE.CanvasTexture> | null = null;

export function faceTextures(): Record<FaceExpression, THREE.CanvasTexture> {
  if (!cache) {
    cache = {
      normal: buildFace('normal'),
      happy: buildFace('happy'),
      dazed: buildFace('dazed'),
    };
  }
  return cache;
}

function buildFace(expr: FaceExpression): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = FACE_TEX_SIZE;
  canvas.height = FACE_TEX_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for face texture');

  const s = FACE_TEX_SIZE;
  // Skin-tone fill so the (small) unwrapped seam around the face reads as head,
  // not transparent black.
  ctx.fillStyle = `#${HEAD_COLOR.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, s, s);

  ctx.strokeStyle = '#1a1a1a';
  ctx.fillStyle = '#1a1a1a';
  ctx.lineWidth = s * 0.045;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const eyeY = s * 0.42;
  const eyeDx = s * 0.2;
  const cx = s * 0.5;

  drawEyes(ctx, expr, cx, eyeY, eyeDx, s);
  drawMouth(ctx, expr, cx, s);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function drawEyes(
  ctx: CanvasRenderingContext2D,
  expr: FaceExpression,
  cx: number,
  eyeY: number,
  eyeDx: number,
  s: number,
): void {
  if (expr === 'dazed') {
    // Spiral-ish ✕ eyes for the 囧 look.
    for (const sign of [-1, 1]) {
      const ex = cx + sign * eyeDx;
      const r = s * 0.07;
      ctx.beginPath();
      ctx.moveTo(ex - r, eyeY - r);
      ctx.lineTo(ex + r, eyeY + r);
      ctx.moveTo(ex + r, eyeY - r);
      ctx.lineTo(ex - r, eyeY + r);
      ctx.stroke();
    }
    return;
  }
  // normal + happy share round dot eyes; happy squints them a touch.
  const ry = expr === 'happy' ? s * 0.05 : s * 0.075;
  for (const sign of [-1, 1]) {
    const ex = cx + sign * eyeDx;
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, s * 0.075, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMouth(ctx: CanvasRenderingContext2D, expr: FaceExpression, cx: number, s: number): void {
  const mouthY = s * 0.68;
  ctx.beginPath();
  if (expr === 'happy') {
    // Big upward grin.
    ctx.arc(cx, mouthY - s * 0.06, s * 0.16, 0.15 * Math.PI, 0.85 * Math.PI);
  } else if (expr === 'dazed') {
    // Wobbly small "o".
    ctx.ellipse(cx, mouthY, s * 0.07, s * 0.09, 0, 0, Math.PI * 2);
  } else {
    // Neutral flat line.
    ctx.moveTo(cx - s * 0.1, mouthY);
    ctx.lineTo(cx + s * 0.1, mouthY);
  }
  ctx.stroke();
}
