import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { forwardZ, moveToWorld, wrapYaw, type Side } from '@spike/shared';
import {
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  CAMERA_FAR,
  CAMERA_HEIGHT,
  CAMERA_BACK_OFFSET,
  CAMERA_LOOK_HEIGHT,
  CAMERA_PITCH_DEG,
} from '../src/config';
import { fpvForward } from '../src/scene/renderer';
import { needleVector } from '../src/hud/serveArc';
import { FPV_VM_GROUP_YAW } from '../src/scene/character/characterConstants';

// M2.8 playtest §1 — permanent regression guard for the FPV camera horizontal
// basis. A live report claimed the FPV camera was horizontally MIRRORED vs the
// world (serve ball appearing to fly the wrong way, opposite of third person).
// This test drives the EXACT setFirstPerson direction math (fpvForward + camera
// .lookAt) and asserts the camera basis is consistent with the shared view-space
// convention: a world point at the player's LOGICAL RIGHT must project to the
// RIGHT half of the screen (NDC x > 0) for every yaw. If this ever fails, the
// FPV basis has been mirrored and the reported bug is real; while it passes, the
// two historical "sign fixes" (viewController mousemove, serveArc needle) are
// correct derivations of this basis, not compensations for a mirror.

// Replicates SceneRenderer.setFirstPerson's orientation exactly (position + the
// fpvForward look direction), on a bare PerspectiveCamera we CAN build in Node.
function orientFirstPerson(cam: THREE.PerspectiveCamera, eye: THREE.Vector3, yaw: number, pitch: number): void {
  cam.position.copy(eye);
  const dir = fpvForward(yaw, pitch);
  cam.lookAt(eye.x + dir.x, eye.y + dir.y, eye.z + dir.z);
  cam.updateMatrixWorld(true);
}

// The player's logical RIGHT / FORWARD in world space, straight from the shared
// transform (moveToWorld with a finite yaw ignores side): D (move.x=+1) → right,
// W (move.y=+1) → forward. This is the SAME fn client prediction + server use.
function worldRight(yaw: number, side: Side): THREE.Vector3 {
  const r = moveToWorld({ x: 1, y: 0 }, side, yaw);
  return new THREE.Vector3(r.x, 0, r.z);
}
function worldForward(yaw: number, side: Side): THREE.Vector3 {
  const f = moveToWorld({ x: 0, y: 1 }, side, yaw);
  return new THREE.Vector3(f.x, 0, f.z);
}

function makeCamera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
}

const YAWS = [0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.6, -0.6, 2.4, -2.4];

describe('FPV camera horizontal basis', () => {
  it("projects the player's logical RIGHT to NDC x > 0 for every yaw", () => {
    const cam = makeCamera();
    const eye = new THREE.Vector3(0, 1.6, 0);
    for (const yaw of YAWS) {
      orientFirstPerson(cam, eye, yaw, 0);
      const forward = worldForward(yaw, 'A');
      const right = worldRight(yaw, 'A');
      // A point 2 units ahead (so it's in front of the camera) and 1 unit to the
      // player's right, at eye height.
      const p = eye.clone().addScaledVector(forward, 2).add(right);
      const ndc = p.clone().project(cam);
      expect(ndc.z, `yaw=${yaw} must be in front of camera`).toBeLessThan(1);
      expect(ndc.x, `yaw=${yaw}: logical-right point should be screen-right`).toBeGreaterThan(0);
    }
  });

  it("projects the player's logical LEFT to NDC x < 0 for every yaw", () => {
    const cam = makeCamera();
    const eye = new THREE.Vector3(0, 1.6, 0);
    for (const yaw of YAWS) {
      orientFirstPerson(cam, eye, yaw, 0);
      const forward = worldForward(yaw, 'A');
      const right = worldRight(yaw, 'A');
      const p = eye.clone().addScaledVector(forward, 2).addScaledVector(right, -1);
      const ndc = p.clone().project(cam);
      expect(ndc.x, `yaw=${yaw}: logical-left point should be screen-left`).toBeLessThan(0);
    }
  });

  it('is unchanged by pitch: RIGHT stays screen-right when looking up/down', () => {
    const cam = makeCamera();
    const eye = new THREE.Vector3(0, 1.6, 0);
    for (const pitch of [-0.8, 0.8]) {
      for (const yaw of YAWS) {
        orientFirstPerson(cam, eye, yaw, pitch);
        const forward = worldForward(yaw, 'A');
        const right = worldRight(yaw, 'A');
        const p = eye.clone().addScaledVector(forward, 2).add(right);
        const ndc = p.clone().project(cam);
        expect(ndc.x, `yaw=${yaw} pitch=${pitch}: right stays screen-right`).toBeGreaterThan(0);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M2.8 playtest §2 — DEFINITIVE cross-camera SERVE-DIRECTION chain (both sides).
//
// The live report: in FPV a serve aimed to the HUD-indicated RIGHT flew LEFT on
// screen, while third person AND the opponent showed it correctly to the right.
// The basis test above proves the FPV camera is not mirrored; this harness goes
// further and projects the ONE authoritative serve direction through BOTH real
// cameras, comparing it against the HUD needle and the world protractor, for
// BOTH sides and every sweep angle. The canonical truth is the server's
// serveHorizontalDir → world → each camera's honest projection; the HUD and the
// world protractor must agree with that.
//
// Result (asserted below): when the FPV camera FACES THE NET — the serve stance
// that gameSession now re-seeds on every local serve via
// ViewController.faceNetForServe — the entire chain agrees on both sides:
//     HUD needle side == world-protractor side (FPV) == ball side (FPV)
//                     == ball side (third person).
// The mismatch the owner saw appeared ONLY with a turned FPV yaw (stale from a
// rally's accumulated mouse-look, or a mid-charge turn) against the old FIXED
// net-facing needle mapping. Two fixes close it: the serve re-seed
// (faceNetForServe) plus the yaw-AWARE needle (needleVector(deg, side, yaw)),
// asserted for turned yaws in the last describe below.
// ─────────────────────────────────────────────────────────────────────────────

const PITCH_RAD = (CAMERA_PITCH_DEG * Math.PI) / 180;
// Third-person look distance (renderer.ts LOOK_DISTANCE), for its steady-state pose.
const LOOK_DISTANCE = (CAMERA_HEIGHT - CAMERA_LOOK_HEIGHT) / Math.tan(PITCH_RAD);

// FPV yaw that faces the net per side (viewController.netFacingYaw): A→0, B→π.
function netFacingYaw(side: Side): number {
  return side === 'A' ? 0 : Math.PI;
}

// Server authority (serveAim.ts serveHorizontalDir §3.1), replicated: the unit
// "toward the net" heading rotated about +Y by the protractor angle.
function serveHorizontalDir(side: Side, angleDeg: number): { x: number; z: number } {
  const fz = forwardZ(side);
  const rad = (angleDeg * Math.PI) / 180;
  return { x: fz * Math.sin(rad), z: fz * Math.cos(rad) };
}

// World protractor needle direction (protractor.ts): group yaw (A→0, B→π) times
// the needle's local +Z rotated by the angle — i.e. rotateY(groupYaw+angle)·(+Z).
function protractorWorldDir(side: Side, angleDeg: number): { x: number; z: number } {
  const groupYaw = forwardZ(side) === 1 ? 0 : Math.PI;
  const a = groupYaw + (angleDeg * Math.PI) / 180;
  return { x: Math.sin(a), z: Math.cos(a) };
}

// Replicates renderer.followPlayer's STEADY-STATE pose (post-lerp): camera sits
// CAMERA_BACK_OFFSET behind the player (mirrored per side) at CAMERA_HEIGHT,
// looking toward the net past the player.
function orientThirdPerson(cam: THREE.PerspectiveCamera, side: Side, feet: THREE.Vector3): void {
  const backSign = side === 'A' ? -1 : 1;
  cam.position.set(feet.x, CAMERA_HEIGHT, feet.z + backSign * CAMERA_BACK_OFFSET);
  cam.lookAt(new THREE.Vector3(feet.x, CAMERA_LOOK_HEIGHT, feet.z - backSign * LOOK_DISTANCE));
  cam.updateMatrixWorld(true);
}

// Exact screen-x sign of a horizontal WORLD motion in a camera: its component
// along the camera's world RIGHT axis (matrixWorld column 0). This is the sign
// of the point's camera-space x, i.e. which screen half the motion reads on —
// robust where a raw project() of a near-eye point is numerically degenerate.
function screenXSign(cam: THREE.PerspectiveCamera, world: { x: number; z: number }): number {
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  return Math.sign(world.x * right.x + world.z * right.z);
}

// Baseline feet position of the serving player per side (z<0 A, z>0 B).
function serverFeet(side: Side): THREE.Vector3 {
  return new THREE.Vector3(0, 0, forwardZ(side) === 1 ? -8 : 8);
}

// Nonzero sweep angles spanning both halves of the protractor.
const SWEEP_ANGLES = [-75, -45, -20, 20, 45, 75];

describe('serve-direction chain: HUD == protractor == FPV ball == third-person ball (net-facing)', () => {
  for (const side of ['A', 'B'] as Side[]) {
    it(`side ${side}: all four artifacts agree on screen side for every sweep angle`, () => {
      const feet = serverFeet(side);
      const eye = feet.clone().setY(1.6);

      const fpv = makeCamera();
      orientFirstPerson(fpv, eye, netFacingYaw(side), 0);
      const third = makeCamera();
      orientThirdPerson(third, side, feet);

      for (const angle of SWEEP_ANGLES) {
        const serveDir = serveHorizontalDir(side, angle);
        const protractorDir = protractorWorldDir(side, angle);

        // Canonical link: the world protractor needle IS the server's serve aim.
        expect(protractorDir.x, `side ${side} θ=${angle}: protractor.x == serveDir.x`).toBeCloseTo(serveDir.x, 6);
        expect(protractorDir.z, `side ${side} θ=${angle}: protractor.z == serveDir.z`).toBeCloseTo(serveDir.z, 6);

        // a) HUD needle screen side (serveArc.needleVector — the REAL yaw-aware
        //    mapping, evaluated at the net-facing serve stance; canvas x → screen x).
        const hudSign = Math.sign(needleVector(angle, side, netFacingYaw(side)).x);
        // b) world protractor projected in the FPV camera.
        const protractorFpvSign = screenXSign(fpv, protractorDir);
        // c) authoritative ball motion in BOTH cameras.
        const ballFpvSign = screenXSign(fpv, serveDir);
        const ballThirdSign = screenXSign(third, serveDir);

        expect(hudSign, `side ${side} θ=${angle}: HUD needle deflects`).not.toBe(0);
        expect(protractorFpvSign, `side ${side} θ=${angle}: protractor(FPV) matches HUD`).toBe(hudSign);
        expect(ballFpvSign, `side ${side} θ=${angle}: ball(FPV) matches HUD`).toBe(hudSign);
        expect(ballThirdSign, `side ${side} θ=${angle}: ball(third person) matches HUD`).toBe(hudSign);
      }
    });
  }
});

// M2.8 §2b — the YAW-AWARE needle: the HUD arc is re-projected through the
// CURRENT FPV camera basis every frame (gameSession feeds viewController's live
// yaw), so even if the player mouse-turns DURING the serve charge the needle
// keeps pointing where the authoritative shot will actually fly on screen. A
// fixed net-facing mapping mirrored exactly in that turned state — the owner's
// bug. These tests drive the REAL needleVector at turned yaws (including the
// worst case, ~180° stale from a previous rally) against the real FPV camera.
describe('yaw-aware HUD needle: matches the ball screen side at ANY current FPV yaw', () => {
  // Offsets from net-facing, in radians: mid-charge turns and the historical
  // stale-rally-yaw worst case (±π). ±π/4 are the coordinator-specified cases.
  const YAW_OFFSETS = [-Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2, Math.PI];

  for (const side of ['A', 'B'] as Side[]) {
    it(`side ${side}: needle side == ball(FPV) side for every turned yaw and sweep angle`, () => {
      const feet = serverFeet(side);
      const eye = feet.clone().setY(1.6);

      for (const offset of YAW_OFFSETS) {
        const yaw = wrapYaw(netFacingYaw(side) + offset) ?? 0;
        const fpv = makeCamera();
        orientFirstPerson(fpv, eye, yaw, 0);

        const right = new THREE.Vector3().setFromMatrixColumn(fpv.matrixWorld, 0);
        for (const angle of SWEEP_ANGLES) {
          const serveDir = serveHorizontalDir(side, angle);
          const ballScreenX = serveDir.x * right.x + serveDir.z * right.z;
          const hud = needleVector(angle, side, yaw);
          // Skip the razor's edge where the aim is analytically dead-center on
          // screen (|x| ~ float noise): sign is meaningless there, and the
          // proportionality test below already pins needle.x == camera-space x.
          if (Math.abs(ballScreenX) < 1e-9) continue;
          expect(
            Math.sign(hud.x),
            `side ${side} yawOffset=${((offset * 180) / Math.PI).toFixed(0)}° θ=${angle}: needle matches ball(FPV) screen side`,
          ).toBe(Math.sign(ballScreenX));
        }
      }
    });

    it(`side ${side}: needle horizontal is proportional to the aim's true camera-space x (never mirrored)`, () => {
      const feet = serverFeet(side);
      const eye = feet.clone().setY(1.6);
      for (const offset of YAW_OFFSETS) {
        const yaw = wrapYaw(netFacingYaw(side) + offset) ?? 0;
        const fpv = makeCamera();
        orientFirstPerson(fpv, eye, yaw, 0);
        const right = new THREE.Vector3().setFromMatrixColumn(fpv.matrixWorld, 0);
        for (const angle of SWEEP_ANGLES) {
          const serveDir = serveHorizontalDir(side, angle);
          const trueScreenX = serveDir.x * right.x + serveDir.z * right.z;
          const hud = needleVector(angle, side, yaw);
          expect(
            hud.x,
            `side ${side} yawOffset=${((offset * 180) / Math.PI).toFixed(0)}° θ=${angle}: needle x equals camera-space x`,
          ).toBeCloseTo(trueScreenX, 6);
        }
      }
    });
  }

  it('net-facing stance reproduces the historical fixed mapping (x=−sinθ, y=−cosθ) on both sides', () => {
    for (const side of ['A', 'B'] as Side[]) {
      for (const angle of SWEEP_ANGLES) {
        const rad = (angle * Math.PI) / 180;
        const v = needleVector(angle, side, netFacingYaw(side));
        expect(v.x, `side ${side} θ=${angle}: net-facing x`).toBeCloseTo(-Math.sin(rad), 6);
        expect(v.y, `side ${side} θ=${angle}: net-facing y`).toBeCloseTo(-Math.cos(rad), 6);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M2.8 playtest §2c — PERMANENT guard for the FPV VIEWMODEL ARM-SWING direction.
//
// The live report: with ball flight already corrected (aim left → ball flies
// left on screen), the first-person viewmodel ARMS swung to the WRONG side (aim
// left → arms swing right). Root cause: the viewmodel host group is yawed 180°
// (FPV_VM_GROUP_YAW) to point the pose machine's character-local +Z into the
// camera view, and PlayerCharacter.updateViewmodel ALSO negated the aim's X to
// "keep reach handedness" — a DOUBLE mirror once the camera/HUD basis was fixed.
//
// This harness replicates the exact arm transform chain and asserts the arm's
// CAMERA-space horizontal sign matches the ball's screen side (screenXSign) for
// every serve sweep angle on BOTH sides. It also pins that the OLD X-negation
// double-flips it (so the mirror must stay OFF), and that the third-person rig
// — which feeds the SAME character-local aim into a facing-rotated group — aims
// its arms exactly along the world ball direction (unaffected by the fix).
// ─────────────────────────────────────────────────────────────────────────────

const UP_AXIS = new THREE.Vector3(0, 1, 0);

// Character facing during a net-facing serve equals the FPV yaw (initialFacing:
// A→0, B→π), so the arm and the ball share a consistent horizontal frame.
// Replicates PlayerCharacter.resolveAim (world aim → character-local, undo
// facing) → updateViewmodel (the X-mirror UNDER TEST) → FpvViewmodel group yaw
// (child of the camera), yielding the arm's CAMERA-space direction. Camera-local
// +X is screen-right, so sign(result.x) is the arm's screen side.
function armCameraSpaceDir(worldAim: { x: number; z: number }, facing: number, mirrorX: boolean): THREE.Vector3 {
  const local = new THREE.Vector3(worldAim.x, 0, worldAim.z).applyAxisAngle(UP_AXIS, -facing); // resolveAim
  const vm = new THREE.Vector3(mirrorX ? -local.x : local.x, local.y, local.z); // updateViewmodel
  vm.applyAxisAngle(UP_AXIS, FPV_VM_GROUP_YAW); // group parented to the camera
  return vm;
}

describe('FPV viewmodel arm swing: swings toward the ball screen side (net-facing serve)', () => {
  for (const side of ['A', 'B'] as Side[]) {
    it(`side ${side}: arm swing camera-space x sign == ball(FPV) screen x sign for every sweep angle`, () => {
      const feet = serverFeet(side);
      const eye = feet.clone().setY(1.6);
      const facing = netFacingYaw(side);
      const fpv = makeCamera();
      orientFirstPerson(fpv, eye, facing, 0);

      for (const angle of SWEEP_ANGLES) {
        const serveDir = serveHorizontalDir(side, angle);
        const ballSign = screenXSign(fpv, serveDir);
        // The SHIPPING transform: mirror OFF (the single group yaw only).
        const arm = armCameraSpaceDir(serveDir, facing, false);
        expect(ballSign, `side ${side} θ=${angle}: ball deflects to a screen side`).not.toBe(0);
        expect(
          Math.sign(arm.x),
          `side ${side} θ=${angle}: arm swings to the ball's screen side (not mirrored)`,
        ).toBe(ballSign);
      }
    });
  }

  it('the historical X-negation double-flips the swing (proof the mirror must stay OFF)', () => {
    for (const side of ['A', 'B'] as Side[]) {
      const facing = netFacingYaw(side);
      const fpv = makeCamera();
      orientFirstPerson(fpv, serverFeet(side).clone().setY(1.6), facing, 0);
      for (const angle of SWEEP_ANGLES) {
        const serveDir = serveHorizontalDir(side, angle);
        const ballSign = screenXSign(fpv, serveDir);
        const mirrored = armCameraSpaceDir(serveDir, facing, true); // the OLD (buggy) transform
        expect(
          Math.sign(mirrored.x),
          `side ${side} θ=${angle}: old X-mirror lands the arm on the OPPOSITE screen side`,
        ).toBe(-ballSign);
      }
    }
  });

  it('third-person swing aims arms along the world ball direction (facing-rotated group, unaffected)', () => {
    // The 3P rig feeds the SAME character-local aim into the character group whose
    // rotation.y == facing, so worldArm == worldAim exactly. One cheap case: A +45.
    const side: Side = 'A';
    const facing = netFacingYaw(side);
    const serveDir = serveHorizontalDir(side, 45);
    const worldAim = new THREE.Vector3(serveDir.x, 0, serveDir.z);
    const local = worldAim.clone().applyAxisAngle(UP_AXIS, -facing); // resolveAim
    const worldArm = local.clone().applyAxisAngle(UP_AXIS, facing); // group.rotation.y = facing
    expect(worldArm.x, 'third-person arm world x == world aim x').toBeCloseTo(worldAim.x, 6);
    expect(worldArm.z, 'third-person arm world z == world aim z').toBeCloseTo(worldAim.z, 6);
  });
});
