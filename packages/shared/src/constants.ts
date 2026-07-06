// Single source of truth for all tunable numeric values (spec §16).
// Imported by shared, server, and client — never re-declare these elsewhere.

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

export const MOVE_SPEED = 4.5; // units/s
export const SPRINT_SPEED = 6.5; // units/s

export const PERFECT_WINDOW_MS = 60; // §6.2 bands
export const GOOD_WINDOW_MS = 150;
export const OK_WINDOW_MS = 300;

export const CHARGE_RATE = 0.8; // per second, to a max of 1.0 (unchanged by M2.4 overcharge — see OVERCHARGE_MAX)
export const CHARGE_MOVE_MULT = 0.45;
export const CHARGE_DISTANCE_MULT_BASE = 1;
export const CHARGE_DISTANCE_MULT_SLOPE = 0.6; // 1 + 0.6 * charge

// M2.4 §5 — overcharge (red zone). Charge accumulates past 1.0 up to this cap
// at the same CHARGE_RATE (~0.375s past the old max-out point). The
// charge->distance/speed pipeline (chargeDistanceMult) keeps eating c > 1
// directly ("too much power"); overchargeQualityMult applies the matching
// quality penalty on top, down to a floor of (1 - OVERCHARGE_QUALITY_PENALTY)
// at c = OVERCHARGE_MAX.
export const OVERCHARGE_MAX = 1.3;
export const OVERCHARGE_QUALITY_PENALTY = 0.5;

// M2.1 §b.1 retune: lower baselines so uncharged is controllable and full
// charge (×1.6, see CHARGE_DISTANCE_MULT_SLOPE) recreates the old punchy ball
// only when earned. See docs/m2.1_plan.md §a/§b.1 for the audit + rationale.
// M3.0a §8.3 — velocity compensation (drag calibration). Flight model v2 adds
// quadratic drag, so the SAME launch speed now lands SHORTER than the old
// drag-free parabola. To keep every prior round's feel/tuning, the two POWER
// base-speeds are bumped so a no-spin flat launch lands within ±5% of the old
// distance (the ONLY sanctioned reason to touch a gameplay base speed — see the
// serveAnchor.test.ts anchor). Derivation (charge-0.8 flat serve / charge-0.85
// spike, drag on):
//   SERVE: 8 → 9.0  (old land 15.51u; base 9.0 lands 15.38u, ratio 0.991)
//   SPIKE: 9 → 10.0 (old land 16.06u; base 10.0 lands 15.84u, ratio 0.986)
// dig/set are short lofts and are intentionally NOT recompensated (spec scoped the
// change to SERVE/SPIKE); their slightly shorter reach is acceptable.
export const SPIKE_BASE_SPEED = 10; // units/s (M3.0a: was 9, drag-compensated)
export const DIG_BASE_SPEED = 4.5; // units/s (was 6; moved from intent/direction.ts)
export const SET_BASE_SPEED = 5.5; // units/s (was 7; moved from intent/direction.ts)
export const SERVE_BASE_SPEED = 9; // units/s (M3.0a: was 8, drag-compensated; decouples serve from spike, fixes G1)
// M2.3 §1: the SERVE_MIN_CHARGE floor is REMOVED — serve charge starts at 0
// like every other touch, HUD shows the raw value, and an under-charged serve
// is allowed to fail naturally (net/own-court death, scored to the opponent
// per the existing dead-ball rules). This is intentional and not a bug.

// M2.3 §3.3 jump-serve tuning (angle-sweep serve, see kinematics/serveSweep.ts
// for the pointer function). Ground serve quality reuses the pre-M2.3 fixed
// serve quality value; jump serve trades a speed boost + tighter scatter for
// double the stamina cost (server-side, §3.3/§9).
export const SERVE_JUMP_SPEED_MULT = 1.25; // ball-speed multiplier when the server releases airborne
export const SERVE_QUALITY_GROUND = 0.8; // fixed quality for a grounded serve release
export const SERVE_QUALITY_JUMP = 0.95; // fixed quality for an airborne (jump) serve release — tighter scatter

export const BASE_SCATTER = 3.0; // units, scatter at quality = 0

// M2.1 §b.2 scale constants — gameplay-relevant player scale (feedback #5).
// Player height/reach now live in shared because touch-reach and future
// blocking depend on them; client visual capsule is rebuilt from these.
export const PLAYER_HEIGHT = 2.0; // units, standing head height (was 1.9 capsule-derived)
export const ARM_REACH = 0.55; // units, hand height above head when reaching up
export const STANDING_REACH = PLAYER_HEIGHT + ARM_REACH; // 2.55 — just touches net (2.43) standing
export const TOUCH_VERTICAL_MARGIN = 0.3; // units, slack on the vertical reach gate (§b.5)

// M2.2 §1.2 jump constants (variable jump — press-to-jump, hold-to-boost).
// Replaces the M2.1 charge-jump system (JUMP_V0_MIN/MAX, JUMP_CHARGE_RATE,
// JUMP_STAMINA_MIN/MAX) — see kinematics/jump.ts.
export const JUMP_V0 = 4.2; // u/s, applied instantly on press
export const JUMP_GRAVITY = 18; // units/s^2 for the character (snappier than ball GRAVITY)
export const JUMP_HOLD_GRAVITY_MULT = 0.45; // gravity multiplier while boosting (<1 = float longer)
export const JUMP_BOOST_MAX_S = 0.3; // boost window, seconds since jump start
export const JUMP_STAMINA_BASE = 6; // charged once, on press
export const JUMP_STAMINA_HOLD_PER_S = 10; // per second while boosting (capped by JUMP_BOOST_MAX_S, ~3 max)

export const STAMINA_MAX = 100;
export const STAMINA_DEADBALL_RECOVER = 25;

export const GRAVITY = 9.8; // units/s^2, ball falls in -Y (tunable)
export const NET_HEIGHT = 2.43; // §3
export const COURT_LEN = 18; // Z span (-9..+9)
export const COURT_WIDTH = 9; // X span (-4.5..+4.5)
export const BALL_RADIUS = 0.15; // GAMEPLAY radius (ground-contact / landing gate in ballistics) — do NOT retune for looks.

// M2.7 playtest §1 — VISUAL-ONLY ball radius. A real volleyball is 0.21m across
// (radius 0.105); rendering at the gameplay BALL_RADIUS (0.15) drew the ball
// ~1.43× oversized. We render at 0.105 × 1.3 readability = 0.14 so the ball
// reads at near-real scale while staying easy to track. Client render only
// (mesh/shadow/trail); server logic and ballistics keep BALL_RADIUS untouched.
export const VISUAL_BALL_RADIUS = 0.14;

// M2.7 §1 — net as a soft obstacle (no more net=dead-ball). The net is the
// z=0 plane, |x| <= COURT_WIDTH/2, y in [0, NET_TOP]. A ball whose trajectory
// crosses that plane below the tape contacts the net; the collision is resolved
// (shared pure function resolveNetCollision) into a NEW BallLaunch from the exact
// contact point/time — a rebound (face) or a damped pass-over (tape). Constants:
export const NET_TOP = NET_HEIGHT; // 2.43 — top of the net band
export const NET_TAPE_H = 0.15; // top 0.15u = the tape zone (pass over, damped)
export const NET_TAPE_DAMP = 0.5; // tape: all velocity components ×0.5
export const NET_TAPE_VY_DROP = 0.5; // tape: extra −0.5 on vy (drags the ball down over the net)
export const NET_RESTITUTION = 0.15; // face: vz reverses at ×0.15 (net absorbs energy)
export const NET_FACE_HORIZ_DAMP = 0.5; // face: vx ×0.5 (vy unchanged — gravity keeps acting)
// Anti-jitter: the resolved launch's origin is nudged this far off the z=0 plane
// along the OUTGOING z direction so the very next trajectory scan can't re-detect
// the same crossing at t≈0 (which would loop forever).
export const NET_CONTACT_EPS = 0.02; // units off the net plane
// If the post-bounce planar speed is below this, the ball is effectively resting
// against the net: it is nudged to the incoming side and left to fall (gravity).
export const NET_MIN_REBOUND_SPEED = 0.5; // units/s

export const RALLY_TARGET = 15; // §9
export const WIN_BY = 2;
export const RALLY_CAP = 21;

// M2.6 §1 — lobby team-slot model. Each side has SLOTS_PER_TEAM fixed slots
// (index 0..5); the room's maxClients = SLOTS_PER_TEAM * 2 = 12. Slot index
// ascending is also the serve-rotation order at match start (§2).
export const SLOTS_PER_TEAM = 6;
export const MAX_PLAYERS = SLOTS_PER_TEAM * 2; // 12

export const REACH_MAX = 1.8; // §6.2 — beyond this horizontal distance, no touch is possible
export const SWEET_SPOT = 0.5; // §6.2 — within this distance, f_distance is 1.0

export const RING_BUFFER_TICKS = 45; // ~1.5s of ball history for lag comp (server-only)

// §6.2 f_distance breakpoints (beyond SWEET_SPOT)
export const DIVE_REACH_START = 1.2; // 0.5 < d <= 1.2: linear 1.0 -> 0.5
export const DIVE_REACH_END = REACH_MAX; // 1.2 < d <= 1.8: linear 0.5 -> 0.1
export const DIVE_REACH_MIN_QUALITY = 0.1;
export const REACH_MID_QUALITY = 0.5;

// Event scan step for deterministic trajectory sampling (§6.4 / plan §4)
export const EVENT_STEP_MS = 4; // 250Hz fixed step

// M2.2 §3.1 dig-only distance curve (mode='dig' only; set/spike keep f_distance
// / REACH_MAX above unchanged).
export const DIG_SWEET = 0.7; // <= -> f_distance = 1.0
export const DIG_DECAY_END = 1.5; // linear 1.0 -> 0.5
export const DIG_REACH_MAX = 2.2; // linear 0.5 -> 0.1; beyond this = dive territory

// M2.2 §3.2 dive (server-authoritative last-resort save attempt for dig).
export const DIVE_REACH_MAX = 3.4; // d in (DIG_REACH_MAX, DIVE_REACH_MAX] => dive attempt
export const DIVE_QUALITY = 0.35; // fixed low quality on dive success
export const DIVE_LUNGE_MAX = 2.0; // units, capped lunge toward the ball point (clamped at net line)
export const DIVE_LOCK_S = 0.8; // seconds of movement lock after a dive
export const DIVE_STAMINA = 15; // stamina cost to attempt a dive (insufficient => whiff, no dive)
export const DIG_VERTICAL_MAX = STANDING_REACH; // §3.2 — dig/dive vertical gate relaxed to standing reach

// M2.2 §4 — serve from outside the court (was ±6.5, inside court in M2.1).
export const COURT_HALF_LENGTH = COURT_LEN / 2; // 9
export const SERVE_SPAWN_Z = COURT_HALF_LENGTH + 0.8; // 9.8 (magnitude; caller applies side sign)

// M2.3 §2 — the back bound behind the baseline, in force for ALL players in
// ALL phases (not just the serve station) while grounded: |z| may not exceed
// this. NOTE (WP1->WP2 handoff): server/src/config.ts currently defines its
// OWN `BACK_BOUND_Z = SERVE_SPAWN_Z` (9.8, serve-only). This shared constant
// (14) is the new, broader §2 value and does NOT yet replace the server one —
// WP2 must switch server call sites to this shared constant and delete the
// server-local definition.
export const BACK_BOUND_Z = COURT_HALF_LENGTH + 5; // 14

// ===========================================================================
// M3.0a — flight model v2 (spec §5) + spin presets (§6) + touch fidelity (§4).
// Folded in from packages/shared/src/physics/constants.ts (WP-P0 lived there so
// P0 couldn't touch this file; P1 §8.2 merges them here as the single source of
// truth). NOTHING re-declares these elsewhere.
// ===========================================================================

// ---- deterministic fixed-step integrator (spec §2) ----
export const PHYSICS_DT = 1 / 240; // s — fixed integration step
// Gravity magnitude for the flight model = the existing ball GRAVITY (§2.1
// "沿用 shared 既有 GRAVITY 值"), so there is exactly one gravity in the codebase.
export const PHYSICS_GRAVITY = GRAVITY; // units/s^2 (magnitude; applied as -Y)
// Quadratic drag: a_drag = -DRAG_K·|v|·v. Exposed as a FlightParams function
// injection point (spec §2.2); this is the P0/P1 constant the default returns.
export const DRAG_K = 0.02; // /m — spike loses ~8% speed over its flight
// Magnus: a_magnus = MAGNUS_K·(ω×v). Full-spin spike adds ≈0.8g of downforce.
export const MAGNUS_K = 0.022;
// Spin cap (clamped at the touch layer, not in the integrator).
export const SPIN_MAX = 45; // rad/s
// Continuous spin decay: dω/dt = -SPIN_DECAY·ω (1s loses ~30%). The integrator
// applies the exact per-step factor exp(-SPIN_DECAY·dt), computed once per launch.
export const SPIN_DECAY = 0.35; // /s
// Fixed bisection iterations for deterministic event-time refinement (spec §5).
export const BISECT_ITERS = 20;

// ---- default spin per touch mode (spec §6) ----
// serve sidespin at full protractor eccentricity (|angle| = 90°); scaled by
// |angle|/90 so a straight (centered) serve carries no sidespin.
export const SERVE_SIDESPIN_MAX = 20; // rad/s
// dig/set carry only a token micro-spin (≤ this), scaled by charge.
export const SPIN_SOFT_MAX = 5; // rad/s

// ---- net contact spin damping (spec §8.4) ----
export const NET_SPIN_DAMP = 0.5; // ω ×= this when a launch is spawned by a net contact

// ---- touch fidelity — timing→execution noise (spec §4/§5) ----
// f = clamp01(1 − (|Δ|/FIDELITY_WINDOW_MS)^FIDELITY_EXP), f=1 inside the PERFECT
// band. The outer edge (f→0) is the OK grading window (reuses the existing band).
export const FIDELITY_WINDOW_MS = OK_WINDOW_MS; // 300
export const FIDELITY_EXP = 1.6; // in/out-of-window feel slope
// Step 1 (direction): worst-timing deflection cone half-angle.
export const ERR_CONE_MAX_RAD = (18 * Math.PI) / 180; // 18°
// Step 2 (power): even the worst timing keeps this fraction of |v| (playability floor).
export const POWER_FLOOR = 0.55;
// Step 3 (spin): ω ×= f^SPIN_FIDELITY_EXP — spin scatters first, direction after.
export const SPIN_FIDELITY_EXP = 1.5;
