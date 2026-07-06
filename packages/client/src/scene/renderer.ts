import * as THREE from 'three';
import { PLAYER_HEIGHT, type Side, type Vec3 } from '@spike/shared';
import {
  CAMERA_BACK_OFFSET,
  CAMERA_FAR,
  CAMERA_FOLLOW_LERP,
  CAMERA_FOV_DEG,
  CAMERA_HEIGHT,
  CAMERA_LOOK_HEIGHT,
  CAMERA_NEAR,
  CAMERA_PITCH_DEG,
  FPV_CAMERA_HEIGHT_MULT,
  MENU_ORBIT_HEIGHT,
  MENU_ORBIT_LOOK_Y,
  MENU_ORBIT_RADIUS,
  MENU_ORBIT_SPEED,
} from '../config';

const FPV_EYE_HEIGHT = PLAYER_HEIGHT * FPV_CAMERA_HEIGHT_MULT; // §5.1 head-height eye

// ─────────────────────────────────────────────────────────────────────────────
// FPV CAMERA HORIZONTAL CONVENTION (M2.8 playtest §1 — the one authoritative note)
//
// A live playtest reported the serve ball appearing to fly the WRONG way in FPV
// vs third person. The suspicion was a horizontally-mirrored FPV camera basis
// (yaw applied as −yaw), with two earlier "sign fixes" (viewController mousemove,
// serveArc needle) feared to be compensations stacked on top of it.
//
// This was proven FALSE by the headless projection test in test/cameraBasis.test.ts.
// The FPV basis built here is horizontally CONSISTENT with the shared view-space
// convention (intent/viewSpace.ts) AND with the third-person follow camera:
//
//   • The camera looks along fpvForward(yaw,pitch); at pitch 0 that is
//     (sin yaw, 0, cos yaw) == shared forward(yaw).
//   • three.js derives camera-right = normalize(cross(up, eye−target)) which,
//     for this look direction, equals shared right(yaw) = moveToWorld({x:1,y:0},
//     side, yaw). So a world point at the player's logical RIGHT projects to
//     NDC x > 0 (screen right) for EVERY yaw — the test asserts exactly this.
//   • For a net-facing player the FPV and third-person cameras share the same
//     horizontal basis, so a given world ball motion reads the same side on both.
//
// Consequently the two earlier sign choices are CORRECT derivations of this basis,
// not compensations: mouse-right → view-right needs yaw −= movementX (because
// increasing yaw rotates forward toward +X, which is screen-LEFT for a net-facing
// side-A player), and the serveArc needle's −sin maps world aim onto screen-right.
// Do NOT "fix" them by flipping a sign — that would REINTRODUCE a mismatch. The
// test is the regression guard for this whole convention.
// ─────────────────────────────────────────────────────────────────────────────

// Pure FPV look direction from yaw/pitch (shared moveToWorld yaw convention:
// yaw=0 → +Z, pitch>0 → up). Exported so the headless camera-basis test drives
// the EXACT direction math setFirstPerson uses, with no drift between them.
export function fpvForward(yaw: number, pitch: number): THREE.Vector3 {
  const cosPitch = Math.cos(pitch);
  return new THREE.Vector3(Math.sin(yaw) * cosPitch, Math.sin(pitch), Math.cos(yaw) * cosPitch);
}

// §5 perf: cap the device-pixel-ratio so friends on weak integrated GPUs don't
// render at 2×/3× native resolution (the main "内顯吃滿" culprit). Applied on
// construction AND on every resize so a window move to a hi-DPI display still
// stays capped.
const MAX_PIXEL_RATIO = 1.5;

// M2.7 §4 — indoor/outdoor environment theme shape. The per-map values live in
// scene/environment.ts; this file only owns applying them (background + the
// two scene lights), so it stays agnostic of MapId itself.
export interface EnvironmentTheme {
  backgroundColor: number;
  ambientColor: number;
  ambientIntensity: number;
  directionalColor: number;
  directionalIntensity: number;
  directionalPos: readonly [number, number, number];
}

const PITCH_RAD = (CAMERA_PITCH_DEG * Math.PI) / 180;
// Forward distance (toward the net) from the camera to a look-at point at
// CAMERA_LOOK_HEIGHT that produces the desired downward pitch, given the
// camera sits CAMERA_HEIGHT above the court: tan(pitch) = drop / distance.
const LOOK_DISTANCE = (CAMERA_HEIGHT - CAMERA_LOOK_HEIGHT) / Math.tan(PITCH_RAD);

// WebGLRenderer + a low, behind-the-back follow camera (M2.1 §4/§f — replaces
// the old fixed 45° semi-top-down court-center camera). The camera sits
// CAMERA_BACK_OFFSET behind the LOCAL player (not court center) and smoothly
// follows them every frame. MIRRORED per side: side A's baseline is more
// negative Z, so its camera sits even further -Z looking toward +Z (the
// net); side B is the exact mirror image.
export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private readonly lookAtTarget = new THREE.Vector3(0, CAMERA_LOOK_HEIGHT, 0);
  private readonly ambientLight: THREE.AmbientLight;
  private readonly directionalLight: THREE.DirectionalLight;

  constructor(mountEl: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    mountEl.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a12);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      window.innerWidth / window.innerHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.directionalLight.position.set(5, 12, 5);
    this.scene.add(this.ambientLight, this.directionalLight);
    // M2.7 §6 — the FPV viewmodel is parented to the camera; the camera must be
    // part of the scene graph for its children to be traversed and rendered.
    this.scene.add(this.camera);

    window.addEventListener('resize', () => this.handleResize());
  }

  private handleResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    // Re-cap on resize too — a display change can raise devicePixelRatio (§5).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // Snaps the camera into a sane starting pose behind the given side's
  // baseline before the local player's actual position is known (e.g. while
  // still in the lobby). followPlayer() takes over once gameplay starts.
  setCameraForSide(side: Side): void {
    const backSign = side === 'A' ? -1 : 1;
    this.camera.position.set(0, CAMERA_HEIGHT, backSign * CAMERA_BACK_OFFSET);
    this.lookAtTarget.set(0, CAMERA_LOOK_HEIGHT, 0);
    this.camera.lookAt(this.lookAtTarget);
  }

  // Smoothly follows the local player every frame: positions the camera
  // CAMERA_BACK_OFFSET behind them (mirrored per side) at CAMERA_HEIGHT, and
  // looks at a point beyond them toward the net so the pitch reads as
  // CAMERA_PITCH_DEG. Lerped (CAMERA_FOLLOW_LERP) so the follow is smooth
  // rather than rigidly locked to the player.
  followPlayer(side: Side, playerPos: Vec3): void {
    const backSign = side === 'A' ? -1 : 1;

    const targetPos = new THREE.Vector3(playerPos.x, CAMERA_HEIGHT, playerPos.z + backSign * CAMERA_BACK_OFFSET);
    const targetLook = new THREE.Vector3(playerPos.x, CAMERA_LOOK_HEIGHT, playerPos.z - backSign * LOOK_DISTANCE);

    this.camera.position.lerp(targetPos, CAMERA_FOLLOW_LERP);
    this.lookAtTarget.lerp(targetLook, CAMERA_FOLLOW_LERP);
    this.camera.lookAt(this.lookAtTarget);
  }

  // M2.3 §5.1 first-person camera: sits at the local player's head
  // (PLAYER_HEIGHT × FPV_CAMERA_HEIGHT_MULT above their feet, so it rises with
  // the jump arc via playerPos.y) and looks along the yaw/pitch heading. Set
  // directly (no lerp) so mouselook feels immediate. The horizontal basis is
  // documented + regression-tested — see the FPV CAMERA HORIZONTAL CONVENTION
  // block above and test/cameraBasis.test.ts. Direction comes from fpvForward so
  // the test exercises the exact same math.
  setFirstPerson(playerPos: Vec3, yaw: number, pitch: number): void {
    const eyeX = playerPos.x;
    const eyeY = playerPos.y + FPV_EYE_HEIGHT;
    const eyeZ = playerPos.z;
    this.camera.position.set(eyeX, eyeY, eyeZ);
    const dir = fpvForward(yaw, pitch);
    this.lookAtTarget.set(eyeX + dir.x, eyeY + dir.y, eyeZ + dir.z);
    this.camera.lookAt(this.lookAtTarget);
  }

  // M2.9 §4 — idle menu camera: a slow circular orbit around court center,
  // shown behind the title menu while no room is joined. main.ts gates this on
  // connection.room === undefined, so the instant a room is entered the follow /
  // FPV camera takes over and this is never called again for that room's
  // lifetime — no hand-off fight (residual-state rule). The angle derives PURELY
  // from the rAF timestamp (no accumulated state), so it resumes seamlessly on a
  // later return to the menu. Never touches gameplay.
  orbitIdle(nowMs: number): void {
    const angle = (nowMs / 1000) * MENU_ORBIT_SPEED;
    this.camera.position.set(
      Math.sin(angle) * MENU_ORBIT_RADIUS,
      MENU_ORBIT_HEIGHT,
      Math.cos(angle) * MENU_ORBIT_RADIUS,
    );
    this.lookAtTarget.set(0, MENU_ORBIT_LOOK_Y, 0);
    this.camera.lookAt(this.lookAtTarget);
  }

  // M2.7 §4 — swap background + lighting for the lobby's chosen map. Driven
  // from scene/environment.ts on every LobbyState broadcast.
  applyEnvironment(theme: EnvironmentTheme): void {
    this.scene.background = new THREE.Color(theme.backgroundColor);
    this.ambientLight.color.setHex(theme.ambientColor);
    this.ambientLight.intensity = theme.ambientIntensity;
    this.directionalLight.color.setHex(theme.directionalColor);
    this.directionalLight.intensity = theme.directionalIntensity;
    this.directionalLight.position.set(...theme.directionalPos);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
