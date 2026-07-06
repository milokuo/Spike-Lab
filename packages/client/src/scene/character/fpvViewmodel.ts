import * as THREE from 'three';
import {
  FPV_CHARGE_POSES,
  FPV_VM_ARM_COLOR,
  FPV_VM_ARM_LENGTH,
  FPV_VM_ARM_RADIUS,
  FPV_VM_GROUP_YAW,
  FPV_VM_RENDER_ORDER,
  FPV_VM_SHOULDER_X,
  FPV_VM_SHOULDER_Y,
  FPV_VM_SHOULDER_Z,
} from './characterConstants';
import { ArmPoseMachine, type PoseInput } from './armPose';

// M2.7 §6 — first-person viewmodel: two simplified capsule arms parented to the
// camera and driven by the SAME ArmPoseMachine states as the third-person rig
// (ready pose while charging, action swing on release, serve-hold). Lightweight
// by design — no head/body/nametag. The host group is yawed 180° so the pose
// machine's local +Z ("forward toward the ball") points into the camera's view
// (-Z); pivots sit low and forward so hands read at the bottom of the screen.
export class FpvViewmodel {
  readonly group: THREE.Group;
  private readonly leftPivot: THREE.Object3D;
  private readonly rightPivot: THREE.Object3D;
  private readonly armMeshes: THREE.Mesh[];
  private readonly pose: ArmPoseMachine;

  constructor() {
    this.group = new THREE.Group();
    this.group.rotation.y = FPV_VM_GROUP_YAW;
    this.group.visible = false;
    // Render on top of the world so the arms never poke through geometry.
    this.group.renderOrder = FPV_VM_RENDER_ORDER;

    this.leftPivot = this.buildArm(-1);
    this.rightPivot = this.buildArm(1);
    this.armMeshes = [
      this.leftPivot.children[0] as THREE.Mesh,
      this.rightPivot.children[0] as THREE.Mesh,
    ];
    this.group.add(this.leftPivot, this.rightPivot);
    // FPV-specific charge poses (§3a/§3c/§4): raise dig into frame, keep the set
    // hands framed. Idle/serve/touch/dive reuse the shared pose builders.
    this.pose = new ArmPoseMachine(this.leftPivot, this.rightPivot, FPV_CHARGE_POSES);
  }

  private buildArm(sideSign: number): THREE.Object3D {
    const pivot = new THREE.Object3D();
    pivot.position.set(sideSign * FPV_VM_SHOULDER_X, FPV_VM_SHOULDER_Y, FPV_VM_SHOULDER_Z);
    const geo = new THREE.CapsuleGeometry(FPV_VM_ARM_RADIUS, FPV_VM_ARM_LENGTH - 2 * FPV_VM_ARM_RADIUS, 3, 6);
    geo.translate(0, -FPV_VM_ARM_LENGTH / 2, 0); // hang below the pivot
    // M2.7 playtest §3b — the arms must ALWAYS draw over world transparents (the
    // net mesh). An OPAQUE material renders in the opaque pass, which three.js
    // draws BEFORE all transparents regardless of renderOrder, so the
    // transparent net painted over the arms. Marking the material transparent
    // moves the arms into the transparent pass, where the high renderOrder
    // (FPV_VM_RENDER_ORDER > the net's default 0) makes them draw LAST; depthTest
    // off keeps them from being culled by world depth.
    const mat = new THREE.MeshStandardMaterial({
      color: FPV_VM_ARM_COLOR,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const arm = new THREE.Mesh(geo, mat);
    arm.renderOrder = FPV_VM_RENDER_ORDER;
    pivot.add(arm);
    return pivot;
  }

  update(input: PoseInput, dtMs: number): void {
    this.pose.update(input, dtMs);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const arm of this.armMeshes) {
      arm.geometry.dispose();
      (arm.material as THREE.Material).dispose();
    }
  }
}
