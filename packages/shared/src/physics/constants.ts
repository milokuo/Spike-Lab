// M3.0a WP-P0 — flight-model v2 tunables (spec §5). These live HERE (inside the
// physics module) on purpose: P0 is not allowed to touch shared/constants.ts.
// P1 will fold these into shared/constants.ts and delete this file's duplicates
// (see m3.0a_spec §1). Until then this is the single source of truth for the
// integrator + spin model, and NOTHING else in the repo imports it.
//
// Gravity is NOT redeclared here — we reuse the existing shared GRAVITY value
// (spec §2.1: "沿用 shared 既有 GRAVITY 值") by importing it, so there is exactly
// one gravity magnitude in the codebase.
import { GRAVITY } from '../constants';

// Re-exported so physics consumers get gravity from one place without reaching
// back into the top-level constants barrel.
export const PHYSICS_GRAVITY = GRAVITY; // units/s^2 (magnitude; applied as -Y)

export const PHYSICS_DT = 1 / 240; // s — fixed integration step (spec §2)

// Quadratic drag coefficient: a_drag = -DRAG_K * |v| * v. Modeled as a function
// injection point in FlightParams (spec §2.2 "Cd 以函數注入點呈現"); this is the
// P0 constant the default function returns. 0c swaps in a speed-dependent curve.
export const DRAG_K = 0.02; // /m

// Magnus: a_magnus = MAGNUS_K * (ω × v).
export const MAGNUS_K = 0.022;

// Spin cap (clamped at the touch layer in P1, not here). Exported for P1 reuse.
export const SPIN_MAX = 45; // rad/s

// Continuous spin-decay rate: dω/dt = -SPIN_DECAY * ω. The integrator applies the
// EXACT per-step solution factor exp(-SPIN_DECAY*dt) (computed once per params,
// never inside the hot loop — spec §2.4).
export const SPIN_DECAY = 0.35; // /s

// Fixed bisection iterations for event refinement (spec §5). Constant so event
// times are bit-deterministic across machines (no tolerance-dependent loop count).
export const BISECT_ITERS = 20;
