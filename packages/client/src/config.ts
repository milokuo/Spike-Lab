// Client-only config: WebSocket URL derivation + render-tuning constants.
// Gameplay numbers live in @spike/shared/constants — never re-declare those here.

import { ROOM_MODE_PRACTICE } from '@spike/shared';

const SERVER_PORT = 2567;

// Derived from location.hostname so a LAN friend's browser (which loaded this
// page from the host's LAN IP) connects back to that same host — NEVER
// hardcode localhost (docs/m2_plan.md WP3 task 2).
export function deriveWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.hostname}:${SERVER_PORT}`;
}

// Render loop / camera tuning (not part of the shared gameplay contract).
// M2.1 §f: behind-the-back follow camera, lower pitch than the old 45°
// semi-top-down view. Client-only tuning knobs — nudge freely, they never
// affect gameplay. // tuning margin: feel free to adjust height/offset/pitch.
export const CAMERA_FOV_DEG = 55;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 200;
export const CAMERA_BACK_OFFSET = 6; // units behind own player along court Z (was 7, fixed court-center cam)
export const CAMERA_HEIGHT = 3.4; // units above court, low behind-the-back cam (was 6)
export const CAMERA_PITCH_DEG = 18; // downward tilt from horizontal (was CAMERA_TILT_DEG 45)
export const CAMERA_LOOK_HEIGHT = 1.6; // eye-level look-at height (~player torso/head)
export const CAMERA_FOLLOW_LERP = 0.12; // per-frame smoothing factor for follow (0..1, higher = snappier)

export const REMOTE_INTERP_DELAY_MS = 100; // render-delay buffer for remote player

export const CLOCK_SYNC_PING_INTERVAL_MS = 1000;
export const CLOCK_SYNC_OFFSET_EMA_ALPHA = 0.15;
export const CLOCK_SYNC_OUTLIER_RTT_MULT = 2;

export const INPUT_SEND_HZ = 30; // matches server TICK_HZ for 1:1 input cadence
export const INPUT_SEND_INTERVAL_MS = 1000 / INPUT_SEND_HZ;

export const PERFECT_HITSTOP_MS = 100; // §10: 0.1s hitstop on PERFECT
export const HUD_POPUP_DURATION_MS = 900;
export const PLAYER_LEFT_BANNER_DURATION_MS = 3000;

// M2.7 §3 — centered scoring banner ("{隊名} 得分 — {原因}"), ~1.8s per spec.
export const SCORE_BANNER_DURATION_MS = 1800;

export const DEBUG_GRID_KEY = 'g'; // toggles 3×3 debug grid (spec §3)

// M2.1 §c: jump prediction. Height at/below this counts as "grounded" for
// reconciliation purposes (float slack, not a gameplay constant).
export const JUMP_GROUND_EPSILON = 0.01;

// M2.5 fix — smooth horizontal reconciliation. The predicted position is the
// SOLE render source every frame; a snapshot correction is NOT teleported onto
// the mesh (that caused the local model+nametag to shake at the 30Hz snapshot
// cadence — invisible on a symmetric capsule, glaring once M2.5 added a
// facing-oriented head/arms/nametag). Instead the correction is absorbed as a
// visual error offset that decays exponentially toward zero, so the mesh moves
// only forward from prediction while quietly converging on authority.
export const RECONCILE_ERROR_DECAY_RATE = 12; // per-second exponential decay of the visual offset (~10-15/s)
// A correction bigger than this is a genuine server teleport (dive lunge, serve
// reposition), not per-snapshot prediction drift — snap to it instead of
// smoothing, so real repositions stay crisp and smoothing can't mask them.
export const RECONCILE_SNAP_THRESHOLD = 1.5; // units

// M2.4 §1: grace window after a locally-predicted jump during which a snapshot
// still showing the player grounded (pos.y ≈ 0) is treated as server-lag — the
// server hasn't processed our jump input yet — rather than a landing. Without
// this, reconcile clobbers the just-started jump back to the ground and the
// local capsule never visibly rises (the serve jump-render bug). Sized to
// comfortably cover ~1 RTT + one snapshot interval.
export const JUMP_PREDICTION_GRACE_MS = 300;

// M2.2 §3 dive presentation (client-only feel tuning). The lunge tilt eases
// out over the server-authoritative movement-lock window (DIVE_LOCK_S), so the
// capsule reads as "diving" for as long as the server keeps the player pinned.
export const DIVE_TILT_MAX_RAD = (65 * Math.PI) / 180; // forward pitch at peak of the lunge
export const DIVE_FEEDBACK_DURATION_MS = 900; // how long the 救球!/撲空! text lingers

// M2.1 §6 serve presentation (feedback #6): during phase 'serve' the ball is
// rendered attached to the serving player's hand — derived locally from the
// serving player's snapshot pos, no new broadcast. SERVE_HAND_HEIGHT mirrors
// the server's SERVE_ORIGIN_Y (packages/server MatchRoom) so the ball does
// not visibly jump the instant the real BallLaunch fires.
export const SERVE_HAND_HEIGHT = 1.5; // units above the player's feet
export const SERVE_HAND_FORWARD_OFFSET = 0.4; // units toward the net, so the ball clears the body

// M2.3 §3.2 protractor render tuning (client-only visuals; the needle angle
// itself comes from the shared pure fn sweepAngleDeg + the synced server clock).
export const PROTRACTOR_RADIUS = 1.6; // units, half-disc radius in front of the server
export const PROTRACTOR_GROUND_Y = 0.03; // slight lift so it z-fights neither ground nor lines

// M2.3 §5 first-person view (client-only feel tuning). yaw/pitch are view-only
// (pitch never affects movement, §5.1); yaw is streamed and drives moveToWorld.
export const FPV_MOUSE_SENSITIVITY = 0.0022; // radians of yaw/pitch per pixel of mouse delta
export const FPV_PITCH_CLAMP_RAD = (60 * Math.PI) / 180; // §5.1 — clamp look up/down to ±60°
export const FPV_CAMERA_HEIGHT_MULT = 0.9; // §5.1 — eye height = PLAYER_HEIGHT × 0.9 above feet

// Lobby (M2.1 §d) — client-only persistence key, not part of the wire contract.
export const LOBBY_NAME_STORAGE_KEY = 'spikelab.playerName';
export const DEFAULT_PLAYER_NAME = 'Player';

// M2.9 §4 — idle menu orbit camera. Driven ONLY while connection.room is
// undefined (main.ts). The instant a room is entered the follow/FPV camera owns
// the camera and orbitIdle is never called again for that room's lifetime, so
// there is no camera hand-off fight (residual-state rule; verified across the
// enter→leave→enter cycle). Pure visual tuning — never affects gameplay.
export const MENU_ORBIT_RADIUS = 13; // units from court center (XZ circle)
export const MENU_ORBIT_HEIGHT = 6; // units above the court
export const MENU_ORBIT_SPEED = 0.05; // rad/s angular velocity
export const MENU_ORBIT_LOOK_Y = 1; // lookAt(0, this, 0) — just above the net base

// M2.9 §1/§5 — practice room create option. The wire literal is FIXED by the
// m2.9 spec (§1): client.create(ROOM_NAME, { mode: 'practice' }). Absent/unknown
// values are treated as a versus room by the server (no throw). WP3 unify: the
// literal now comes from @spike/shared (RoomMode / ROOM_MODE_PRACTICE) so
// client and server share the single source of truth instead of each side
// carrying its own copy.
export { ROOM_MODE_PRACTICE };
export interface PracticeCreateOptions {
  mode: typeof ROOM_MODE_PRACTICE;
}
