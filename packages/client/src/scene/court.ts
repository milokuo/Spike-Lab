import * as THREE from 'three';
import { COURT_LEN, COURT_WIDTH, NET_HEIGHT } from '@spike/shared';

const HALF_WIDTH = COURT_WIDTH / 2;
const HALF_LENGTH = COURT_LEN / 2;
const GRID_DIVISIONS = 3; // §3: 3×3 debug grid per half

const GROUND_COLOR = 0x2b6e3f;
const LINE_COLOR = 0xffffff;
const NET_COLOR = 0x1a1a1a;
const NET_POST_COLOR = 0x333333;
const GRID_COLOR = 0xffee55;

// M2.7 §9a bonus VFX — brief wobble on the net plane when a BallLaunch carries
// isNetTouch (net rebound/tape-pass). Self-ticking (its own rAF loop) so
// callers don't need a per-frame update hook — just call triggerNetShake().
const NET_SHAKE_DURATION_MS = 220;
const NET_SHAKE_AMPLITUDE_RAD = 0.08;

// Low-poly court: ground plane, boundary lines, net plane, and an optional
// debug 3×3-per-half grid overlay (spec §3). Returns the group + a toggle fn.
export interface CourtHandle {
  group: THREE.Group;
  setDebugGridVisible: (visible: boolean) => void;
  // M2.7 §4 — swap the ground tint for the lobby's chosen map (indoor/outdoor);
  // court lines/net stay identical, only this material's color changes.
  setGroundColor: (color: number) => void;
  triggerNetShake: () => void;
}

export function buildCourt(): CourtHandle {
  const group = new THREE.Group();

  const groundMaterial = new THREE.MeshStandardMaterial({ color: GROUND_COLOR });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(COURT_WIDTH, COURT_LEN), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  group.add(buildBoundaryLines());
  const netGroup = buildNet();
  group.add(netGroup);

  const debugGrid = buildDebugGrid();
  debugGrid.visible = false;
  group.add(debugGrid);

  return {
    group,
    setDebugGridVisible: (visible: boolean) => {
      debugGrid.visible = visible;
    },
    setGroundColor: (color: number) => {
      groundMaterial.color.setHex(color);
    },
    triggerNetShake: createNetShaker(netGroup),
  };
}

// A ball can touch the net multiple times per rally (§1), so triggerNetShake()
// can fire again before a prior shake finishes. Rather than spawning a new
// independent rAF loop per call (which would stack concurrent loops fighting
// over the same rotation.z — including an earlier loop zeroing it out mid-shake
// of a newer one), keep ONE shared start time + ONE running loop: a re-trigger
// just resets the start time and the existing loop picks up the restart.
function createNetShaker(netGroup: THREE.Object3D): () => void {
  let shakeStart: number | null = null;
  let running = false;

  const tick = (): void => {
    if (shakeStart === null) {
      running = false;
      return;
    }
    const t = (performance.now() - shakeStart) / NET_SHAKE_DURATION_MS;
    if (t >= 1) {
      netGroup.rotation.z = 0;
      shakeStart = null;
      running = false;
      return;
    }
    netGroup.rotation.z = Math.sin(t * Math.PI * 3) * NET_SHAKE_AMPLITUDE_RAD * (1 - t);
    requestAnimationFrame(tick);
  };

  return () => {
    shakeStart = performance.now();
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  };
}

function buildBoundaryLines(): THREE.Object3D {
  const points = [
    new THREE.Vector3(-HALF_WIDTH, 0.01, -HALF_LENGTH),
    new THREE.Vector3(HALF_WIDTH, 0.01, -HALF_LENGTH),
    new THREE.Vector3(HALF_WIDTH, 0.01, HALF_LENGTH),
    new THREE.Vector3(-HALF_WIDTH, 0.01, HALF_LENGTH),
    new THREE.Vector3(-HALF_WIDTH, 0.01, -HALF_LENGTH),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: LINE_COLOR }));
}

function buildNet(): THREE.Object3D {
  const group = new THREE.Group();

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT_WIDTH, NET_HEIGHT),
    new THREE.MeshStandardMaterial({
      color: NET_COLOR,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    }),
  );
  mesh.position.set(0, NET_HEIGHT / 2, 0);
  group.add(mesh);

  const postGeometry = new THREE.CylinderGeometry(0.06, 0.06, NET_HEIGHT, 8);
  const postMaterial = new THREE.MeshStandardMaterial({ color: NET_POST_COLOR });
  for (const x of [-HALF_WIDTH, HALF_WIDTH]) {
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.position.set(x, NET_HEIGHT / 2, 0);
    group.add(post);
  }

  return group;
}

// Hidden by default (players never see it); toggled via DEBUG_GRID_KEY.
function buildDebugGrid(): THREE.Object3D {
  const group = new THREE.Group();
  const cellWidth = COURT_WIDTH / GRID_DIVISIONS;
  const cellLength = HALF_LENGTH / GRID_DIVISIONS;
  const material = new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.5 });

  for (const halfSign of [-1, 1]) {
    for (let row = 0; row <= GRID_DIVISIONS; row++) {
      const z = halfSign * row * cellLength;
      const points = [
        new THREE.Vector3(-HALF_WIDTH, 0.02, z),
        new THREE.Vector3(HALF_WIDTH, 0.02, z),
      ];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    for (let col = 0; col <= GRID_DIVISIONS; col++) {
      const x = -HALF_WIDTH + col * cellWidth;
      const points = [
        new THREE.Vector3(x, 0.02, 0),
        new THREE.Vector3(x, 0.02, halfSign * HALF_LENGTH),
      ];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
  }

  return group;
}
