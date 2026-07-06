import { OVERCHARGE_MAX, forwardZ, type Side } from '@spike/shared';

// M2.7 §7 — bottom-center 2D semicircle serve-direction HUD, shown ONLY in FPV
// during the serve phase when it is YOUR serve (the world protractor is not
// readable from first person). The needle angle comes from the SAME shared
// sweepAngleDeg + synced server clock that drives the world protractor, so both
// always agree. Charge is drawn as a radial fill inside the arc. Hidden in third
// person (GameSession only calls update(true, …) in FPV+own-serve).

const CANVAS_W = 240;
const CANVAS_H = 132;
const CENTER_X = CANVAS_W / 2;
const CENTER_Y = CANVAS_H - 14; // arc pivots near the bottom edge
const RADIUS = 104;
const ARC_BG = 'rgba(255,255,255,0.16)';
const ARC_RIM = 'rgba(255,255,255,0.6)';
const FILL_NORMAL = 'rgba(255,176,63,0.5)';
const FILL_OVER = 'rgba(255,64,64,0.6)';
const NEEDLE_COLOR = '#ff5a5a';
const TICK_COLOR = 'rgba(255,255,255,0.4)';

// sweepAngleDeg ∈ [-90, +90] is the WORLD serve-aim angle, measured about +Y
// from "toward the net" (server authority: serveAim.ts serveHorizontalDir).
//
// M2.8 playtest §2b — YAW-AWARE needle. The FPV arc is a SCREEN overlay, so its
// needle must show where the authoritative shot will go in the CURRENT camera,
// not in an assumed net-facing stance (the serve start re-seeds yaw net-facing,
// but the player can mouse-turn DURING the charge — a fixed mapping would lie
// again the moment they do). Derivation, all in the shared conventions:
//   • world aim (serveAim.ts serveHorizontalDir): rotate towardNet=(0, fz) by θ
//       about +Y → aim = (fz·sinθ, fz·cosθ) in world (x, z), fz = forwardZ(side).
//   • FPV camera basis at heading `yaw` (viewSpace.ts forward/rightFromYaw,
//       exactly what renderer.setFirstPerson + camera.lookAt produce):
//       forward = (sin yaw, cos yaw), right = (−cos yaw, sin yaw).
//   • screen-right component = aim·right   = fz·sin(yaw − θ)
//     view-forward component = aim·forward = fz·cos(yaw − θ)
// Canvas x grows right and y grows DOWN, so x = screen-right and y = −forward.
// Net-facing check (yaw = 0 for A, π for B): x = −sinθ, y = −cosθ on BOTH sides
// — identical to the previous fixed mapping, so the seeded stance is unchanged.
// Exported so the cross-camera harness (test/cameraBasis.test.ts) asserts the
// REAL HUD needle mapping, not a copy: needleVector(deg, side, yaw).x > 0 means
// the needle points to the player's screen-right in the CURRENT view.
export function needleVector(deg: number, side: Side, yaw: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  const fz = forwardZ(side);
  return { x: fz * Math.sin(yaw - rad), y: -fz * Math.cos(yaw - rad) };
}

export class ServeArcHud {
  readonly root: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor() {
    this.root = document.createElement('canvas');
    this.root.className = 'hud-serve-arc';
    this.root.width = CANVAS_W;
    this.root.height = CANVAS_H;
    this.root.style.display = 'none';
    const ctx = this.root.getContext('2d');
    if (!ctx) throw new Error('serve-arc HUD: 2D canvas context unavailable');
    this.ctx = ctx;
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none';
  }

  // needleDeg ∈ [-90, +90] (sweepAngleDeg); charge is the raw 0..OVERCHARGE_MAX
  // value (the fill fraction scales to the overcharge cap, matching the bar).
  // side + yaw orient the needle (and ticks) in the CURRENT FPV view so the
  // needle always points where the ball will actually fly on screen (§2b).
  update(needleDeg: number, charge: number, side: Side, yaw: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Background half-disc (upper semicircle: π .. 2π in canvas angle terms).
    ctx.beginPath();
    ctx.moveTo(CENTER_X, CENTER_Y);
    ctx.arc(CENTER_X, CENTER_Y, RADIUS, Math.PI, 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = ARC_BG;
    ctx.fill();

    // Charge fill: inner half-disc whose radius grows with charge.
    const fillFrac = Math.min(1, Math.max(0, charge / OVERCHARGE_MAX));
    if (fillFrac > 0) {
      ctx.beginPath();
      ctx.moveTo(CENTER_X, CENTER_Y);
      ctx.arc(CENTER_X, CENTER_Y, RADIUS * fillFrac, Math.PI, 2 * Math.PI);
      ctx.closePath();
      ctx.fillStyle = charge > 1 ? FILL_OVER : FILL_NORMAL;
      ctx.fill();
    }

    // Tick marks at -90/-45/0/45/90, oriented in the same current-view basis as
    // the needle so the whole dial reads consistently while turning.
    ctx.strokeStyle = TICK_COLOR;
    ctx.lineWidth = 1.5;
    for (const deg of [-90, -45, 0, 45, 90]) {
      const v = needleVector(deg, side, yaw);
      ctx.beginPath();
      ctx.moveTo(CENTER_X + v.x * (RADIUS - 12), CENTER_Y + v.y * (RADIUS - 12));
      ctx.lineTo(CENTER_X + v.x * RADIUS, CENTER_Y + v.y * RADIUS);
      ctx.stroke();
    }

    // Rim arc.
    ctx.beginPath();
    ctx.arc(CENTER_X, CENTER_Y, RADIUS, Math.PI, 2 * Math.PI);
    ctx.strokeStyle = ARC_RIM;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Needle.
    const n = needleVector(needleDeg, side, yaw);
    ctx.beginPath();
    ctx.moveTo(CENTER_X, CENTER_Y);
    ctx.lineTo(CENTER_X + n.x * (RADIUS - 6), CENTER_Y + n.y * (RADIUS - 6));
    ctx.strokeStyle = NEEDLE_COLOR;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Pivot dot.
    ctx.beginPath();
    ctx.arc(CENTER_X, CENTER_Y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = NEEDLE_COLOR;
    ctx.fill();
  }
}

export const SERVE_ARC_STYLES = `
  .hud-serve-arc { position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%); pointer-events: none; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.6)); z-index: 6; }
`;
