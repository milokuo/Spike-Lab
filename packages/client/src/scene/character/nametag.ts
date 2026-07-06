import * as THREE from 'three';
import {
  NAMETAG_CANVAS_H,
  NAMETAG_CANVAS_W,
  NAMETAG_FONT_PX,
} from './characterConstants';

// M2.5 §2 — the floating name label. A THREE.Sprite is inherently
// camera-facing, so it billboards for free; PlayerCharacter rescales it by
// camera distance for constant on-screen legibility. White text with a dark
// outline (drawn into a CanvasTexture) stays readable over court/sky/players.
export interface Nametag {
  readonly sprite: THREE.Sprite;
  dispose(): void;
}

export function buildNametag(name: string): Nametag {
  const canvas = document.createElement('canvas');
  canvas.width = NAMETAG_CANVAS_W;
  canvas.height = NAMETAG_CANVAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for nametag');

  drawName(ctx, name);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    // Draw over players/court so the label is never occluded by a body in front.
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;

  return {
    sprite,
    dispose(): void {
      texture.dispose();
      material.dispose();
    },
  };
}

function drawName(ctx: CanvasRenderingContext2D, name: string): void {
  const w = NAMETAG_CANVAS_W;
  const h = NAMETAG_CANVAS_H;
  ctx.clearRect(0, 0, w, h);
  ctx.font = `700 ${NAMETAG_FONT_PX}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  // Trim overly long names so they never overflow the fixed canvas width.
  const label = name.length > 14 ? `${name.slice(0, 13)}…` : name;

  // Dark outline first, white fill on top.
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 6;
  ctx.strokeText(label, w / 2, h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, w / 2, h / 2);
}
