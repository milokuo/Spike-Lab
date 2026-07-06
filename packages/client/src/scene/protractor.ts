import * as THREE from 'three';
import { forwardZ, type Side, type Vec3 } from '@spike/shared';
import { PROTRACTOR_GROUND_Y, PROTRACTOR_RADIUS } from '../config';

const DISC_COLOR = 0xffe14d;
const RIM_COLOR = 0xffffff;
const NEEDLE_COLOR = 0xff5a5a;
const DISC_SEGMENTS = 32;

// Local +Z of the group is "toward the net": the whole group is yawed by π for
// side B so its local +Z maps to world -Z. This makes the needle's local
// heading (sin θ, 0, cos θ) reproduce the server's authoritative serve aim
// (rotateY(towardNet, θ)) on BOTH sides — see docs/m2.3_spec.md §3.2.
function groupYawForSide(side: Side): number {
  return forwardZ(side) === 1 ? 0 : Math.PI;
}

// M2.3 §3.2 — the 180° half-disc "protractor" drawn on the ground in front of
// the serving player during the serve phase. Everyone renders it (readability
// rule): the needle angle is the shared pure fn sweepAngleDeg fed by the synced
// server clock, so all clients agree. Deliberately simple: a translucent fan +
// rim arc + a single needle line.
export class Protractor {
  readonly group: THREE.Group;
  private readonly needle: THREE.Line;

  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.add(this.buildDisc());
    this.group.add(this.buildRim());
    this.needle = this.buildNeedle();
    this.group.add(this.needle);
  }

  // pos/side identify the serving player; needleDeg is sweepAngleDeg(elapsed)
  // (∈ [-90, +90]) or null when the phase-start time is not yet known — in
  // which case the disc still shows but the needle is hidden (spec: defensively
  // hide the needle if servePhaseStartServerTime is absent).
  update(pos: Vec3, side: Side, needleDeg: number | null): void {
    this.group.visible = true;
    this.group.position.set(pos.x, PROTRACTOR_GROUND_Y, pos.z);
    this.group.rotation.y = groupYawForSide(side);
    if (needleDeg === null) {
      this.needle.visible = false;
      return;
    }
    this.needle.visible = true;
    this.needle.rotation.y = (needleDeg * Math.PI) / 180;
  }

  hide(): void {
    this.group.visible = false;
  }

  // Translucent half-disc: a CircleGeometry covering the upper (y>0) semicircle,
  // laid flat so its open face points along local +Z (toward the net).
  private buildDisc(): THREE.Mesh {
    const geometry = new THREE.CircleGeometry(PROTRACTOR_RADIUS, DISC_SEGMENTS, 0, Math.PI);
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: DISC_COLOR,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    return new THREE.Mesh(geometry, material);
  }

  // Rim outline: the semicircular arc plus the straight baseline behind it.
  private buildRim(): THREE.Line {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= DISC_SEGMENTS; i++) {
      const theta = -Math.PI / 2 + (Math.PI * i) / DISC_SEGMENTS; // -90° .. +90° from +Z
      points.push(new THREE.Vector3(Math.sin(theta) * PROTRACTOR_RADIUS, 0, Math.cos(theta) * PROTRACTOR_RADIUS));
    }
    points.push(new THREE.Vector3(-PROTRACTOR_RADIUS, 0, 0)); // close the flat edge
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: RIM_COLOR, transparent: true, opacity: 0.5 }));
  }

  // Needle: a line along local +Z; rotation.y = angle sets its heading so
  // rotateY(+Z, θ) = (sin θ, 0, cos θ), matching the server's serve aim.
  private buildNeedle(): THREE.Line {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.01, 0),
      new THREE.Vector3(0, 0.01, PROTRACTOR_RADIUS),
    ]);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: NEEDLE_COLOR, linewidth: 2 }));
  }
}
