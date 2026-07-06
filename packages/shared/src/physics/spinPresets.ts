// M3.0a §6 — default spin per touch mode (0a has no dedicated spin input yet;
// 0b adds a touch-point bias key). Each preset builds a view-space SpinIntent and
// funnels it through spinIntentToWorld — the ONE place a per-side mirror or yaw
// is allowed to touch spin (iron rule 2). Callers pass yaw = null because the
// rally/serve launch direction is itself resolved in the third-person, per-side
// convention (resolveIntent → viewToWorld, serveHorizontalDir), so the spin must
// use the SAME convention. Never mirror ω yourself downstream.
import { SERVE_SIDESPIN_MAX, SPIN_MAX, SPIN_SOFT_MAX } from '../constants';
import type { Vec3 } from '../math/vec3';
import type { Side } from '../types/state';
import type { TouchMode } from '../types/messages';
import { spinIntentToWorld, type SpinIntent } from './spin';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Spike: topspin proportional to charge, capped at SPIN_MAX. Magnus then presses
// the ball DOWN for the readable arcade "下扎" (spec §5/§6).
export function spikeSpin(charge: number): SpinIntent {
  return { kind: 'top', rate: clamp(SPIN_MAX * charge, 0, SPIN_MAX) };
}

// Serve: SIDESPIN whose magnitude ∝ how far off-center the protractor was aimed
// (|angleDeg|/90) and whose curve direction matches the aim — "偏哪側彎哪側"
// (spec §6). The protractor's +angle sweeps toward the hitter's screen-LEFT
// (serveHorizontalDir: aim·screen-right = −sinθ), so +angle ⇒ side-L (curves
// left), −angle ⇒ side-R. The per-side world resolution is spinIntentToWorld's
// job; sidespin's world ω is ±up (side-independent) and the per-side curve falls
// out of Magnus = ω × v where v already carries forwardZ(side). A centered
// (angle 0) serve carries no sidespin.
export function serveSpin(angleDeg: number): SpinIntent {
  const rate = (Math.abs(angleDeg) / 90) * SERVE_SIDESPIN_MAX;
  return { kind: angleDeg >= 0 ? 'side-L' : 'side-R', rate };
}

// Dig / set: only a token micro-spin (≤ SPIN_SOFT_MAX), scaled by charge, for
// visual liveliness — no meaningful Magnus at this magnitude (spec §6).
export function softSpin(charge: number): SpinIntent {
  return { kind: 'top', rate: SPIN_SOFT_MAX * clamp(charge, 0, 1) };
}

// World-ω convenience wrappers (yaw = null — third-person per-side convention,
// aligned with the launch-direction resolvers). These are what the sim calls.
export function spikeSpinWorld(charge: number, side: Side): Vec3 {
  return spinIntentToWorld(spikeSpin(charge), side, null);
}
export function serveSpinWorld(angleDeg: number, side: Side): Vec3 {
  return spinIntentToWorld(serveSpin(angleDeg), side, null);
}
export function softSpinWorld(charge: number, side: Side): Vec3 {
  return spinIntentToWorld(softSpin(charge), side, null);
}

// Rally-touch dispatcher: spike gets topspin, dig/set get the micro-spin.
export function rallySpinWorld(mode: TouchMode, charge: number, side: Side): Vec3 {
  return mode === 'spike' ? spikeSpinWorld(charge, side) : softSpinWorld(charge, side);
}
