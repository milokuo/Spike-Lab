// M2.5 §2/§3 — ALL character-visual tunables in ONE place (spec §3: "常數集中").
// Nudge freely; none of these touch gameplay (pure client presentation).
import { PLAYER_HEIGHT, type TouchMode } from '@spike/shared';

/* ---- body capsule (unchanged from M2.2 §2.3) ---- */
export const CAPSULE_RADIUS = 0.35;
// Cylindrical mid-section so total capsule height == PLAYER_HEIGHT (shared).
export const CAPSULE_CYLINDER_HEIGHT = PLAYER_HEIGHT - 2 * CAPSULE_RADIUS;

// M2.2 §2.3 — capsule tint by touchMode (readability / mind-games). Applied to
// BOTH local and remote from snapshot.mode.
export const MODE_TINT: Record<TouchMode, number> = {
  dig: 0x3fa7ff, // blue
  set: 0x4dd67c, // green
  spike: 0xff5a5a, // red
};
// Local body glows so you can tell yourself apart from same-mode opponents.
export const LOCAL_EMISSIVE_MULT = 0.35;

/* ---- head + face ---- */
export const HEAD_RADIUS = 0.3;
export const HEAD_CENTER_Y = PLAYER_HEIGHT + HEAD_RADIUS * 0.15; // perched atop the capsule
export const HEAD_COLOR = 0xffe0bd; // cartoon skin tone (face drawn as texture)
export const FACE_TEX_SIZE = 128; // CanvasTexture resolution per expression

/* ---- arms (two capsules pivoted at the shoulders) ---- */
export const ARM_RADIUS = 0.09;
export const ARM_LENGTH = 0.95;
export const SHOULDER_Y = PLAYER_HEIGHT - CAPSULE_RADIUS - 0.12; // upper torso height
export const SHOULDER_X = CAPSULE_RADIUS + ARM_RADIUS * 0.6; // just outside the body
export const ARM_COLOR = 0xffe0bd;

/* ---- nametag (billboard sprite) ---- */
export const NAMETAG_Y = HEAD_CENTER_Y + HEAD_RADIUS + 0.4; // floats above the head
export const NAMETAG_CANVAS_W = 256;
export const NAMETAG_CANVAS_H = 64;
export const NAMETAG_FONT_PX = 40;
// Constant on-screen legibility: the sprite is rescaled every frame by its
// distance to the camera so its apparent (pixel) size stays ~fixed regardless
// of depth — see PlayerCharacter.updateNametagScale. (Chosen over pure
// perspective scaling, which shrinks names to dots across the court.)
export const NAMETAG_REF_DISTANCE = 8; // units at which the base scale applies
export const NAMETAG_BASE_W = 1.6; // sprite world width at the reference distance
export const NAMETAG_ASPECT = NAMETAG_CANVAS_H / NAMETAG_CANVAS_W;
export const NAMETAG_MIN_SCALE = 0.45; // clamps so it never balloons/vanishes
export const NAMETAG_MAX_SCALE = 3.2;
// Quantize the distance-derived scale factor so tiny per-frame camera-distance
// wobble doesn't re-resample the sprite every frame (visible shimmer). The
// follow-cam keeps the local player at a near-constant distance, so quantizing
// pins its nametag to a single step; remotes step in smooth 0.1 increments.
export const NAMETAG_SCALE_QUANTUM = 0.1;

/* ---- facing interpolation ---- */
// Remote players slerp toward their snapshot facing (shortest arc — no 2π
// spins); the local player snaps (own facing computed instantly from input).
export const FACING_LERP_RATE = 12; // per-second approach factor

/* ---- pose machine (§3 / M2.7 §6) ---- */
export const POSE_SLERP_RATE = 10; // quaternion slerp rate /s (spec: ~8-12)
export const SWING_FREQ = 6.5; // rad/s of the walk-cycle swing sine
export const SWING_AMP_RAD = 0.7; // forward/back swing amplitude at full speed
export const SWING_IDLE_FACTOR = 0.12; // residual sway when standing still
export const MODE_IDLE_LEAN_RAD = 0.22; // subtle mode-specific idle bias (remote telegraph)
export const JUMP_ARM_RAISE_RAD = (26 * Math.PI) / 180; // §3 jump overlay 20-30°
// M2.7 §6 — the RELEASE action animation window (~0.35s). Charging holds a
// STATIC ready pose; the moment H (or FPV LMB) is released this window plays a
// swing THROUGH the ball, driven by touchProgress01 (0→1 over this window).
export const TOUCH_POSE_MS = 350;
export const DIVE_ARM_FORWARD_RAD = (95 * Math.PI) / 180; // arms thrown along the dive
export const DIVE_BODY_TILT_RAD = (58 * Math.PI) / 180; // body lunge pitch

// Charging preparatory poses (§3, per touchMode). Euler radians per arm as
// [pitchX, yawY, rollZ] in character-local space. SIGN NOTE: at rest each arm
// points straight down (0,-1,0); a NEGATIVE pitchX swings it FORWARD (toward
// +Z / the net), a POSITIVE pitchX swings it BACK, and ±π points it overhead.
export interface ArmEuler {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface ChargePose {
  readonly left: ArmEuler;
  readonly right: ArmEuler;
}
export const CHARGE_POSES: Record<TouchMode, ChargePose> = {
  // dig — both arms extended FORWARD and low, hands drawn inward (platform).
  dig: {
    left: { x: -1.15, y: 0, z: -0.4 },
    right: { x: -1.15, y: 0, z: 0.4 },
  },
  // set — SYMMETRIC both-hands-overhead ball-framing ready pose (M2.8 playtest
  // §2, owner revert: last round's asymmetric pose was a mis-speak). Both arms
  // raised forward-and-up HIGH and mostly up (x≈-2.5 → dir ~(0,+0.80,+0.60)),
  // hands drawn INWARD via mirrored z-rolls (left −, right +) so they frame the
  // ball above the forehead like an overhead pass. Symmetric on purpose.
  set: {
    left: { x: -2.5, y: 0, z: -0.28 },
    right: { x: -2.5, y: 0, z: 0.28 },
  },
  // spike — ASYMMETRIC forward-and-up reach (M2.8 playtest §2, owner rework):
  // the RIGHT arm is raised forward-and-up HIGH (x≈-2.5 → dir ~(0,+0.80,+0.60),
  // mostly up), the LEFT arm reaches forward diagonal-up slightly LOWER
  // (x≈-2.05 → dir ~(0,+0.46,+0.89), more forward). Distinct from set's
  // symmetric ball-frame; reads as an approach-and-swing wind-up.
  spike: {
    left: { x: -2.05, y: 0, z: -0.2 },
    right: { x: -2.5, y: 0, z: 0.15 },
  },
};

// M2.7 §6 — the RELEASE action swing, per mode. A progress-driven pitch delta
// (radians) applied about the shoulder-pivot X on TOP of the aim-toward-ball
// quaternion, interpolated startPitch→endPitch across the TOUCH_POSE_MS window
// (smoothstep-eased). NEGATIVE pitch swings an arm FORWARD/up, POSITIVE swings
// it BACK/down (same sign convention as ArmEuler.x above), so:
//   dig  — platform scoops from low up through the ball
//   set  — both hands push up and out
//   spike— dominant arm whips from cocked-high over the top and down
export interface ActionSwing {
  readonly startPitch: number;
  readonly endPitch: number;
}
export const ACTION_SWINGS: Record<TouchMode, ActionSwing> = {
  dig: { startPitch: 0.85, endPitch: -0.7 },
  set: { startPitch: 0.3, endPitch: -0.7 },
  spike: { startPitch: -1.45, endPitch: 0.9 },
};

// Serve-hold (§3 "serve hold"): dominant hand fronts the held ball, other arm
// hangs. touch-burst spike keeps the off-arm forward for balance.
export const SERVE_HOLD_DOMINANT: ArmEuler = { x: -1.45, y: 0, z: 0.1 };
export const SERVE_HOLD_OFF: ArmEuler = { x: 0.12, y: 0, z: 0.05 };
export const SPIKE_TOUCH_BALANCE: ArmEuler = { x: -0.6, y: 0, z: 0.12 };

/* ---- FPV viewmodel (M2.7 §6) — two simplified capsule arms attached to the
   camera and driven by the SAME pose machine states as the third-person rig.
   Head/body/nametag stay hidden in FPV. The host group is yawed 180° so the
   arms' local +Z (pose-machine "forward toward the ball") maps to the camera's
   -Z (into the view); pivots sit low and forward so hands read at the bottom of
   the screen without clipping the near plane (CAMERA_NEAR 0.1). ---- */
export const FPV_VM_ARM_RADIUS = 0.075;
export const FPV_VM_ARM_LENGTH = 0.62;
export const FPV_VM_SHOULDER_X = 0.15; // half-separation of the two arms (was 0.17 — pulled in so set hands stay framed, §3c)
export const FPV_VM_SHOULDER_Y = -0.3; // below the eye (was -0.42 — raised so the dig ready pose sits in frame, §3a)
export const FPV_VM_SHOULDER_Z = 0.5; // group-local +Z → camera -Z (in front)
export const FPV_VM_GROUP_YAW = Math.PI; // face arms into the view
export const FPV_VM_ARM_COLOR = ARM_COLOR;
// M2.7 playtest §3b — the viewmodel arms draw in the TRANSPARENT pass with this
// renderOrder so they paint over the transparent net (default renderOrder 0);
// see fpvViewmodel.buildArm for why an opaque material was occluded instead.
export const FPV_VM_RENDER_ORDER = 100;

// M2.7 playtest §3/§6 — FPV-specific charge ready poses. The third-person
// CHARGE_POSES are authored for a camera looking AT the player; from first
// person the same pitches drop the hands off the bottom (dig) or splay them off
// the side (set), so the viewmodel gets its own tuned dig/set. Spike reuses the
// shared pose (its cocked/forward arms already frame well). Same ArmEuler sign
// convention as CHARGE_POSES (negative x = forward/up).
export const FPV_CHARGE_POSES: Record<TouchMode, ChargePose> = {
  // dig — forearms held nearly HORIZONTAL forward (x≈-1.5 → dir ~(0,-0.07,+1)),
  // hands drawn inward, so the platform reads in the lower-center of the frame
  // instead of hanging below it.
  dig: {
    left: { x: -1.5, y: 0, z: -0.32 },
    right: { x: -1.5, y: 0, z: 0.32 },
  },
  // set — SYMMETRIC overhead ball-frame (mirrors the reworked third-person set,
  // M2.8 §2) with gentler symmetric z-rolls so both raised hands stay inside the
  // frame from first person (§3c).
  set: {
    left: { x: -2.45, y: 0, z: -0.16 },
    right: { x: -2.45, y: 0, z: 0.16 },
  },
  // spike — ASYMMETRIC forward-and-up (M2.8 §2). The third-person spike now
  // reaches forward-up rather than cocking BACK, which is exactly what FPV
  // needs: a back-cocked arm swung its hand toward the camera and clipped the
  // near plane (0.1). Here BOTH arms point forward-up (away from the eye), so
  // nothing clips; the LEFT arm is held lower AND rolled outward (z −0.3) so it
  // sits at the bottom-left and never blocks the centre of the view.
  spike: {
    left: { x: -2.0, y: 0, z: -0.3 },
    right: { x: -2.45, y: 0, z: 0.14 },
  },
};

/* ---- face expression windows (§2) ---- */
export const HAPPY_FACE_MS = 1000; // 1s of 開心臉 after own PERFECT
export const DAZED_FACE_MS = 1000; // 1s of 囧臉 after own WHIFF / dive_fail

// Dominant (spiking/serving) arm.
export const DOMINANT_ARM: 'left' | 'right' = 'right';

// §5 remote touch telegraph: TouchResult is toucher-only, but BallLaunch is
// broadcast. When a launch fires, the toucher sits ~at the ball origin, so the
// nearest remote within this radius plays its touch-burst pose (no wire change).
export const REMOTE_TOUCH_BURST_RADIUS = 2.5; // units
