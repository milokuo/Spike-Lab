import * as THREE from 'three';
import { VISUAL_BALL_RADIUS, ballPosition, firstEvent, type BallLaunch, type Side, type Vec3 } from '@spike/shared';
import { SERVE_HAND_FORWARD_OFFSET, SERVE_HAND_HEIGHT } from '../config';

const BALL_COLOR = 0xffd23f;
const MAX_FLIGHT_MS = 5000; // safety bound for firstEvent scan

// M2.4 §3 — jump-serve visual: an orange-red emissive glow on the ball plus a
// same-tinted afterimage trail, held until the next touch (a BallLaunch without
// the flag) or a dead ball resets it.
const JUMP_SERVE_EMISSIVE = 0xff3a00; // orange-red glow
const JUMP_SERVE_EMISSIVE_INTENSITY = 0.9;
const TRAIL_GHOSTS = 10; // afterimage samples
const TRAIL_HEAD_OPACITY = 0.5; // nearest ghost; fades to ~0 at the tail

// M2.6 §4 — ground blob shadow. A dark translucent disc pinned to the floor
// under the ball; opacity/size track height (higher = fainter + more spread).
// M2.7 §9b fix — the old fixed 0.55 radius was ~3.7× the ball, so a grounded
// ball read as sitting inside a shadow visibly bigger than itself. Base radius
// is now derived from the VISUAL ball radius (~0.9×, i.e. slightly SMALLER than
// the ball at rest) and the height-growth factor is halved so it doesn't
// balloon back past the ball on any real airborne moment either.
const SHADOW_RADIUS = VISUAL_BALL_RADIUS * 0.9; // base disc radius (u), slightly under the ball's own radius
const SHADOW_SEGMENTS = 24;
const SHADOW_BASE_OPACITY = 0.4;
const SHADOW_GROUND_Y = 0.01; // just above the court to avoid z-fighting
const SHADOW_FADE_HEIGHT = 8; // ballY at which the shadow fully fades out
const SHADOW_SPREAD_PER_Y = 0.025; // radius grows ×(1 + ballY×this) — halved from 0.05

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Pose to hold the ball at during phase 'serve' (M2.1 §6/feedback #6):
// derived locally from the serving player's snapshot pos, no new broadcast.
export interface ServeHold {
  pos: Vec3;
  side: Side;
}

// Ball mesh: during phase 'serve' it is pinned to the serving player's hand
// (ServeHold); otherwise its position is derived PURELY from the latest
// BallLaunch packet via the shared ballistics fn — no local ball physics
// (plan WP3). M2.4 §3 adds the jump-serve tint + afterimage trail.
export class BallView {
  readonly mesh: THREE.Mesh;
  // Afterimage ghosts live in their own group so the caller adds them to the
  // scene alongside the ball (they hold world positions, not ball-relative).
  readonly trailGroup: THREE.Group;
  // §4 blob shadow — a floor disc the caller adds to the scene; positioned in
  // world space (not ball-relative) so it stays glued to the ground.
  readonly shadow: THREE.Mesh;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly ghosts: THREE.Mesh[] = [];
  private activeLaunch: BallLaunch | undefined;
  private freezeAtMs: number | undefined;
  private jumpServeTint = false;

  constructor() {
    this.material = new THREE.MeshStandardMaterial({ color: BALL_COLOR });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(VISUAL_BALL_RADIUS, 12, 10), this.material);
    this.mesh.visible = false;

    // §4 — flat disc on the XZ plane (rotate the default +Z-facing circle down),
    // drawn without depth-write and after the floor (renderOrder) so it never
    // z-fights the court despite sitting a hair above it.
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: SHADOW_BASE_OPACITY,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(SHADOW_RADIUS, SHADOW_SEGMENTS), this.shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = SHADOW_GROUND_Y;
    this.shadow.renderOrder = 1;
    this.shadow.visible = false;

    this.trailGroup = new THREE.Group();
    this.trailGroup.visible = false;
    for (let i = 0; i < TRAIL_GHOSTS; i++) {
      const opacity = TRAIL_HEAD_OPACITY * (1 - i / TRAIL_GHOSTS);
      const ghostMat = new THREE.MeshBasicMaterial({
        color: JUMP_SERVE_EMISSIVE,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      // Slightly smaller than the ball so the trail reads as a fading wake.
      const ghost = new THREE.Mesh(new THREE.SphereGeometry(VISUAL_BALL_RADIUS * 0.85, 10, 8), ghostMat);
      ghost.visible = false;
      this.ghosts.push(ghost);
      this.trailGroup.add(ghost);
    }
  }

  setLaunch(launch: BallLaunch): void {
    this.activeLaunch = launch;
    this.freezeAtMs = firstEvent(launch, MAX_FLIGHT_MS).atMs;
    this.mesh.visible = true;
    // A new BallLaunch WITHOUT the flag = the next touch after the serve, which
    // clears the tint (§3). Only an actual jump serve (re)arms it.
    this.setJumpServeTint(launch.isJumpServe === true);
  }

  // §3 — explicit tint reset used on dead-ball / death events.
  clearJumpServeTint(): void {
    this.setJumpServeTint(false);
  }

  private setJumpServeTint(on: boolean): void {
    this.jumpServeTint = on;
    if (on) {
      this.material.emissive.setHex(JUMP_SERVE_EMISSIVE);
      this.material.emissiveIntensity = JUMP_SERVE_EMISSIVE_INTENSITY;
    } else {
      this.material.emissive.setHex(0x000000);
      this.material.emissiveIntensity = 0;
      this.hideTrail();
    }
  }

  // Clears any stale trajectory so a new serve phase doesn't briefly show
  // the previous rally's frozen landing spot before the hand-hold pose (or
  // the next BallLaunch) takes over.
  reset(): void {
    this.activeLaunch = undefined;
    this.freezeAtMs = undefined;
    this.mesh.visible = false;
    this.shadow.visible = false;
    this.setJumpServeTint(false);
  }

  // serverTimeNow: current authoritative-clock estimate (ms), same units as
  // launch.serverTime, per ClockSync.serverTimeNow(). serveHold, when
  // non-null, takes priority over any in-flight trajectory.
  update(serverTimeNow: number, serveHold: ServeHold | null): void {
    if (serveHold) {
      const forwardSign = serveHold.side === 'A' ? 1 : -1;
      this.mesh.position.set(
        serveHold.pos.x,
        serveHold.pos.y + SERVE_HAND_HEIGHT,
        serveHold.pos.z + forwardSign * SERVE_HAND_FORWARD_OFFSET,
      );
      this.mesh.visible = true;
      this.updateTrail();
      this.updateShadow();
      return;
    }

    if (!this.activeLaunch) {
      this.shadow.visible = false;
      return;
    }
    const elapsedMs = Math.min(serverTimeNow - this.activeLaunch.serverTime, this.freezeAtMs ?? Infinity);
    const pos = ballPosition(this.activeLaunch, Math.max(0, elapsedMs));
    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.updateTrail();
    this.updateShadow();
  }

  // §4 — glue the blob to the ball's ground projection every frame; fade + grow
  // it with height (higher ball = fainter, more spread), hide when no ball.
  private updateShadow(): void {
    if (!this.mesh.visible) {
      this.shadow.visible = false;
      return;
    }
    const ballY = this.mesh.position.y;
    this.shadow.position.set(this.mesh.position.x, SHADOW_GROUND_Y, this.mesh.position.z);
    this.shadowMaterial.opacity = SHADOW_BASE_OPACITY * clamp01(1 - ballY / SHADOW_FADE_HEIGHT);
    const scale = 1 + ballY * SHADOW_SPREAD_PER_Y;
    this.shadow.scale.set(scale, scale, scale);
    this.shadow.visible = true;
  }

  // Shifts the afterimage samples toward the tail and drops the current ball
  // position onto the head, so the ghosts trace the ball's recent path. Only
  // visible while the jump-serve tint is active (§3).
  private updateTrail(): void {
    if (!this.jumpServeTint || !this.mesh.visible) {
      this.hideTrail();
      return;
    }
    this.trailGroup.visible = true;
    for (let i = this.ghosts.length - 1; i > 0; i--) {
      const ghost = this.ghosts[i];
      const prev = this.ghosts[i - 1];
      if (!ghost || !prev) continue;
      ghost.position.copy(prev.position);
      ghost.visible = prev.visible;
    }
    const head = this.ghosts[0];
    if (head) {
      head.position.copy(this.mesh.position);
      head.visible = true;
    }
  }

  private hideTrail(): void {
    this.trailGroup.visible = false;
    for (const ghost of this.ghosts) ghost.visible = false;
  }
}
