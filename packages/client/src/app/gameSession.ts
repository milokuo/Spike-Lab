import * as THREE from 'three';
import type { Room } from 'colyseus.js';
import {
  DIVE_LOCK_S,
  MOVE_SPEED,
  computeFacing,
  initialFacing,
  sweepAngleDeg,
  type ArcType,
  type BallLaunch,
  type MatchPhase,
  type PlayerSnapshot,
  type Side,
  type StateSnapshot,
  type TeamNames,
  type TouchMode,
  type TouchResult,
  type Vec3,
} from '@spike/shared';
import type { ServeHold } from '../scene/ball';
import { BallView } from '../scene/ball';
import { Protractor } from '../scene/protractor';
import { PlayerCharacter, type CharacterFrame } from '../scene/player';
import { REMOTE_TOUCH_BURST_RADIUS } from '../scene/character/characterConstants';
import { SceneRenderer } from '../scene/renderer';
import type { CourtHandle } from '../scene/court';
import { applyMapEnvironment } from '../scene/environment';
import { KeyboardInput } from '../input/keyboard';
import { LocalPlayer } from '../player/localPlayer';
import { RemotePlayer } from '../player/remotePlayer';
import { Hud } from '../hud/hud';
import { ViewController } from '../view/viewController';
import { onBallLaunch, onDeath, onLobbyState, onSnapshot, onTouchResult, sendInput, sendTouch } from '../net/messages';
import { LobbyView } from '../lobby/lobbyView';
import { INPUT_SEND_INTERVAL_MS, JUMP_GROUND_EPSILON } from '../config';

const DEFAULT_TEAM_NAMES: TeamNames = { A: 'A 隊', B: 'B 隊' };

const DIVE_ANIM_DURATION_MS = DIVE_LOCK_S * 1000;

// Phases in which FPV (§5) is allowed — i.e. an actually-playing match, not the
// lobby or gameover screen (those own the pointer for their own UI).
const FPV_PHASES: ReadonlySet<MatchPhase> = new Set<MatchPhase>(['serve', 'rally', 'deadball']);

// M2.5 §3 — a launch's arcType maps onto the pose machine's touchMode variants
// (serve swings like a spike). Used to pick a remote player's touch-burst pose.
const ARC_TO_TOUCH_MODE: Record<ArcType, TouchMode> = {
  dig: 'dig',
  set: 'set',
  spike: 'spike',
  serve: 'spike',
};

interface RemoteEntry {
  remote: RemotePlayer;
  character: PlayerCharacter;
  facing: number; // latest snapshot facing (radians); interpolated toward each frame
  prevPos: Vec3 | null; // last rendered pos, for speed derivation
  side: Side;
  isCharging: boolean; // M2.8 §1/§3 — last snapshot charge state (ready pose + falling-edge swing)
  lastTouchBurstMs: number; // M2.8 §3 — dedup so a release edge + its BallLaunch don't double-swing
}

// M2.8 §3 — one swing per remote release. A real contact fires BOTH a BallLaunch
// (ball-aimed, see handleBallLaunch) and an isCharging true→false snapshot edge;
// this window collapses the two near-simultaneous triggers into a single burst.
const REMOTE_BURST_DEDUP_MS = 200;

// The serving player's render info for the §3.2 protractor. phaseStart is the
// authoritative server time the serve phase began.
interface ServeRender {
  pos: Vec3;
  side: Side;
  phaseStart: number | null;
}

// Owns everything that depends on a live match room: local/remote player
// state, the ball view, and HUD/lobby wiring in response to server messages.
export class GameSession {
  private localPlayer: LocalPlayer | undefined;
  private localCharacter: PlayerCharacter | undefined;
  private localSide: Side | undefined;
  private localFacing = 0; // §1 — computed locally every frame (snappy, no snapshot wait)
  private prevLocalPos: Vec3 | null = null;
  private remotePlayers = new Map<string, RemoteEntry>();
  private knownPlayerIds = new Set<string>();
  private playerNames = new Map<string, string>();
  private currentServeHold: ServeHold | null = null;
  private inputAccumulatorMs = 0;
  private keyboard: KeyboardInput | undefined;
  private lastPhase: MatchPhase | undefined;
  private currentPhase: MatchPhase | undefined;
  private servingId: string | null = null;
  private sessionId = ''; // own session id (for the broadcast-TouchResult local/remote split)
  private localServing = false;
  private serveRender: ServeRender | null = null;
  private readonly protractor = new Protractor();
  private teamNames: TeamNames = DEFAULT_TEAM_NAMES;
  // M2.9 §5 — client-local practice flag (self-created sandbox room, so we know
  // without any wire signal). Drives the neutral death banner + HUD chip; the
  // scoreboard is hidden by hud.setPracticeMode. Cleared on reset().
  private isPractice = false;

  constructor(
    private readonly scene: SceneRenderer,
    private readonly ballView: BallView,
    private readonly hud: Hud,
    private readonly lobbyView: LobbyView,
    private readonly viewController: ViewController,
    private readonly court: CourtHandle,
  ) {
    this.scene.scene.add(this.protractor.group);
  }

  get side(): Side | undefined {
    return this.localSide;
  }

  get player(): LocalPlayer | undefined {
    return this.localPlayer;
  }

  wireRoom(room: Room, keyboard: KeyboardInput, isPractice = false): void {
    this.keyboard = keyboard;
    this.sessionId = room.sessionId;
    // §5 — practice: hide the (frozen 0:0) scoreboard and show the practice chip.
    this.isPractice = isPractice;
    this.hud.setPracticeMode(isPractice);
    onSnapshot(room, (snapshot) => this.handleSnapshot(room, snapshot));
    onBallLaunch(room, (launch) => this.handleBallLaunch(launch));
    onTouchResult(room, (result) => this.handleTouchResult(result));
    onLobbyState(room, (state) => {
      this.lobbyView.setLobbyState(state, room.sessionId);
      this.teamNames = state.teamNames;
      this.hud.setTeamNames(state.teamNames);
      // §4 — visual-only environment swap; gameplay/court lines are untouched.
      applyMapEnvironment(this.scene, this.court, state.map);
    });
    onDeath(room, (event) => {
      this.ballView.clearJumpServeTint();
      // §3 — centered scoring banner using the current lobby-set team name.
      // M2.9 §5 — practice: score is frozen, so show a neutral re-serve line
      // instead of a team-scoring show.
      if (this.isPractice) this.hud.showPracticeResetBanner();
      else this.hud.showScoreBanner(this.teamNames[event.scoringSide], event.scoringSide, event.cause);
    });

    keyboard.onTouch((touchEvent) => {
      // M2.8 §3 — AIR SWING: play the action on EVERY release, regardless of
      // whether a ball is contacted. Exactly one burst per release; its aim is
      // resolved live in PlayerCharacter.resolveAim (the ball if it's in contact
      // range, else the player's facing), so a landed touch is still ball-aimed
      // without a second trigger from the TouchResult.
      this.localCharacter?.triggerTouch(touchEvent.mode);
      sendTouch(room, {
        playerId: room.sessionId,
        clientTime: touchEvent.clientTime,
        mode: touchEvent.mode,
        charge: touchEvent.charge,
        dirInput: touchEvent.dirInput,
      });
    });

    keyboard.onJumpPress(() => this.localPlayer?.startJumpPrediction());
  }

  tickJump(dtMs: number, held: boolean): void {
    this.localPlayer?.tickJump(dtMs, held);
  }

  // M2.2 §3 / M2.5 §3: dive presentation + §2 face reactions. TouchResult is now
  // BROADCAST (carries playerId), so character-level reactions — happy/dazed face
  // and the dive lunge — play on the IDENTIFIED player's character whether it's
  // local or remote. HUD text feedback (grade popup, 救球!/撲空!, 連擊犯規!) and the
  // local WASD dive-lock stay LOCAL-ONLY (only when the result is our own).
  private handleTouchResult(result: TouchResult): void {
    const isOwn = result.playerId === this.sessionId;
    const remoteEntry = isOwn ? undefined : this.remotePlayers.get(result.playerId);
    const character = isOwn ? this.localCharacter : remoteEntry?.character;

    // HUD grade popup — LOCAL ONLY.
    if (isOwn) this.hud.showTouchResult(result);

    // §2 — PERFECT → happy; WHIFF-grade / illegal / dive_fail → dazed (1s each).
    // Applied to the identified player's character (local or remote).
    if (result.grade === 'PERFECT') character?.showHappy();
    else if (
      result.grade === 'WHIFF' ||
      result.outcome === 'dive_fail' ||
      result.outcome === 'illegal_double' ||
      result.outcome === 'illegal_count'
    ) {
      character?.showDazed();
    }
    // M2.8 §3 — a normal/air swing burst is fired locally on the H/LMB RELEASE
    // (see wireRoom); for a REMOTE it comes from the BallLaunch (ball-aimed) or
    // the isCharging falling edge (facing-aimed), deduped in triggerRemoteBurst.

    // §2 — illegal_* rejections show red feedback text only (LOCAL): no dive
    // lunge/lock; the ball keeps flying its original trajectory.
    if (result.outcome === 'illegal_double' || result.outcome === 'illegal_count') {
      if (isOwn) this.hud.showIllegalTouchFeedback(result.outcome);
      return;
    }
    // Only DIVE outcomes drive the dive presentation below.
    if (result.outcome !== 'dive_success' && result.outcome !== 'dive_fail') return;
    if (isOwn) {
      this.hud.showDiveFeedback(result.outcome); // §3 HUD text — LOCAL ONLY
      this.localPlayer?.beginDiveLock(); // authoritative WASD freeze — LOCAL ONLY
    }
    // Dive lunge visual for the identified character (local or remote). For a
    // remote, stamp the swing dedup window so the near-simultaneous isCharging
    // falling edge can't ALSO fire a normal swing burst — the TouchResult-aimed
    // dive wins within its REMOTE_BURST_DEDUP_MS window.
    if (remoteEntry) remoteEntry.lastTouchBurstMs = performance.now();
    character?.triggerDive(DIVE_ANIM_DURATION_MS);
  }

  // §5 remote telegraph: BallLaunch is broadcast (TouchResult is not), so use it
  // to fire the touch-burst pose on whichever REMOTE sits at the ball's origin.
  private handleBallLaunch(launch: BallLaunch): void {
    this.ballView.setLaunch(launch);
    // §1 bonus VFX — brief net wobble on a net rebound/tape-pass launch; the
    // trajectory itself needs no special handling (already continuous).
    if (launch.isNetTouch) this.court.triggerNetShake();
    const mode = ARC_TO_TOUCH_MODE[launch.arcType];
    let nearest: RemoteEntry | null = null;
    let nearestDist = REMOTE_TOUCH_BURST_RADIUS;
    for (const entry of this.remotePlayers.values()) {
      const pos = entry.prevPos;
      if (!pos) continue;
      const dist = Math.hypot(pos.x - launch.origin.x, pos.z - launch.origin.z);
      if (dist < nearestDist) {
        nearest = entry;
        nearestDist = dist;
      }
    }
    // §5 / M2.8 §3 — ball-aimed remote burst; dedups against the isCharging
    // release edge so a real contact swings exactly once.
    if (nearest) this.triggerRemoteBurst(nearest, mode);
  }

  // M2.8 §3 — fire a remote's swing burst at most once per REMOTE_BURST_DEDUP_MS,
  // shared by the ball-aimed BallLaunch path and the facing-aimed isCharging
  // true→false release edge so the two never stack into a double swing.
  private triggerRemoteBurst(entry: RemoteEntry, mode: TouchMode): void {
    const now = performance.now();
    if (now - entry.lastTouchBurstMs < REMOTE_BURST_DEDUP_MS) return;
    entry.lastTouchBurstMs = now;
    entry.character.triggerTouch(mode);
  }

  pumpInput(room: Room, keyboard: KeyboardInput, dtMs: number): void {
    if (!this.localPlayer) return;
    this.inputAccumulatorMs += dtMs;
    while (this.inputAccumulatorMs >= INPUT_SEND_INTERVAL_MS) {
      this.inputAccumulatorMs -= INPUT_SEND_INTERVAL_MS;
      const frame = this.localPlayer.applyInput(keyboard.sample(), INPUT_SEND_INTERVAL_MS, this.viewController.currentYaw());
      sendInput(room, frame);
    }
  }

  // Per-frame visual sync: local character, remote interpolation, ball, camera,
  // and the serve protractor (§3.2). dtMs drives pose swing + facing interp.
  updateVisuals(dtMs: number, serverTimeNow: number | undefined): void {
    if (this.keyboard) {
      this.hud.setMode(this.keyboard.currentTouchMode());
      this.hud.setSelection(this.keyboard.currentSelectionIndex()); // §8 selected cell
    }

    const firstPerson = this.viewController.viewMode === 'first';
    const ballWorld = this.ballVisible() ? vecOf(this.ballView.mesh.position) : null;
    const cameraPos = this.scene.camera.position;

    if (this.localCharacter && this.localPlayer && this.localSide) {
      // Decay the reconcile smoothing offset with real per-frame dt BEFORE
      // reading position, so the mesh converges on prediction every frame
      // rather than teleporting at the 30Hz snapshot cadence (M2.5 jitter fix).
      this.localPlayer.decayError(dtMs);
      const pos = this.localPlayer.position;
      this.updateLocalFacing();
      this.localCharacter.setFirstPersonSelf(firstPerson);
      this.localCharacter.update({
        dtMs,
        feet: pos,
        facing: this.localFacing,
        snapFacing: true, // local = instant/snappy (§1)
        speed01: this.speedOf(this.prevLocalPos, pos, dtMs),
        airborne: pos.y > JUMP_GROUND_EPSILON,
        charging: (this.keyboard?.currentCharge() ?? 0) > 0,
        serving: this.localServing,
        ballWorld,
        cameraPos,
      });
      this.prevLocalPos = pos;

      if (firstPerson) {
        this.scene.setFirstPerson(pos, this.viewController.lookYaw, this.viewController.lookPitch);
      } else {
        this.scene.followPlayer(this.localSide, pos);
      }
    }

    if (serverTimeNow === undefined) return;
    this.ballView.update(serverTimeNow, this.serveHoldForRender());
    this.updateProtractor(serverTimeNow);
    this.updateServeArc(firstPerson, serverTimeNow); // §7 FPV serve HUD
    for (const [id, entry] of this.remotePlayers) {
      const pos = entry.remote.positionAt(serverTimeNow);
      entry.character.update({
        dtMs,
        feet: pos,
        facing: entry.facing,
        snapFacing: false, // remote = smooth shortest-arc interpolation
        speed01: this.speedOf(entry.prevPos, pos, dtMs),
        airborne: pos.y > JUMP_GROUND_EPSILON,
        charging: entry.isCharging, // M2.8 §1 — authoritative charge state → ready pose (was mode-lean fallback)
        serving: this.currentPhase === 'serve' && this.servingId === id,
        ballWorld: this.ballVisible() ? ballWorld : null,
        cameraPos,
      } satisfies CharacterFrame);
      entry.prevPos = pos;
    }
  }

  // Horizontal speed as a 0..1 fraction of MOVE_SPEED, for the walk-swing scale.
  private speedOf(prev: Vec3 | null, cur: Vec3, dtMs: number): number {
    if (!prev || dtMs <= 0) return 0;
    const dist = Math.hypot(cur.x - prev.x, cur.z - prev.z);
    const speed = dist / (dtMs / 1000);
    return Math.min(1, speed / MOVE_SPEED);
  }

  // §1 — local facing from the SAME inputs the prediction uses (yaw in FPV,
  // else movement direction, else hold), so it's instant and never lags.
  private updateLocalFacing(): void {
    if (!this.keyboard || !this.localSide) return;
    const move = this.keyboard.sample().move;
    this.localFacing = computeFacing(this.localFacing, this.localSide, move, this.viewController.currentYaw());
  }

  private ballVisible(): boolean {
    return this.ballView.mesh.visible;
  }

  private serveHoldForRender(): ServeHold | null {
    if (this.localServing && this.localPlayer && this.localSide) {
      return { pos: this.localPlayer.position, side: this.localSide };
    }
    return this.currentServeHold;
  }

  private updateProtractor(serverTimeNow: number): void {
    if (!this.serveRender) {
      this.protractor.hide();
      return;
    }
    const { side, phaseStart } = this.serveRender;
    const pos =
      this.localServing && this.localPlayer ? this.localPlayer.position : this.serveRender.pos;
    const needleDeg = phaseStart === null ? null : sweepAngleDeg(serverTimeNow - phaseStart);
    this.protractor.update(pos, side, needleDeg);
  }

  // §7 — the FPV serve-direction arc HUD: shown ONLY in first person during your
  // own serve. The needle comes from the SAME sweepAngleDeg + synced server
  // clock as the world protractor; charge is the live H/LMB charge value. Third
  // person hides it (the world protractor already suffices).
  private updateServeArc(firstPerson: boolean, serverTimeNow: number): void {
    const start = this.serveRender?.phaseStart ?? null;
    if (!firstPerson || !this.localServing || start === null || !this.localSide) {
      this.hud.updateServeArc(false, 0, 0);
      return;
    }
    const needleDeg = sweepAngleDeg(serverTimeNow - start);
    const charge = this.keyboard?.currentCharge() ?? 0;
    // M2.8 §2b — feed the LIVE FPV yaw so the needle is projected through the
    // CURRENT camera basis every frame: it keeps pointing where the ball will
    // actually fly on screen even if the player mouse-turns mid-charge.
    this.hud.updateServeArc(true, needleDeg, charge, this.localSide, this.viewController.lookYaw);
  }

  // §4 — the SINGLE room-lifecycle teardown. Disposes every piece of
  // match-specific state so a fresh create/join rebuilds from a clean slate.
  reset(): void {
    if (this.localCharacter) {
      this.scene.scene.remove(this.localCharacter.group);
      this.localCharacter.dispose();
    }
    for (const { character } of this.remotePlayers.values()) {
      this.scene.scene.remove(character.group);
      character.dispose();
    }
    this.remotePlayers.clear();
    this.knownPlayerIds.clear();
    this.playerNames.clear();
    this.localPlayer = undefined;
    this.localCharacter = undefined;
    this.localSide = undefined;
    this.localFacing = 0;
    this.prevLocalPos = null;
    this.currentServeHold = null;
    this.serveRender = null;
    this.protractor.hide();
    this.inputAccumulatorMs = 0;
    this.lastPhase = undefined;
    this.currentPhase = undefined;
    this.servingId = null;
    this.localServing = false;
    this.teamNames = DEFAULT_TEAM_NAMES;
    this.isPractice = false; // §5 — HUD chip/scoreboard restored by resetMatchState below
    this.viewController.setActive(false);
    this.keyboard?.clearListeners();
    this.keyboard?.setInputActive(false);
    this.ballView.reset();
    this.hud.resetMatchState();
  }

  private handleSnapshot(room: Room, snapshot: StateSnapshot): void {
    this.lobbyView.setPhaseVisibility(snapshot.phase);
    if (snapshot.phase === 'gameover') this.lobbyView.showGameOver(snapshot.score);
    this.hud.setScore(snapshot.score);
    this.hud.setPhase(snapshot.phase);
    this.hud.setRoster(snapshot.players, room.sessionId);

    this.keyboard?.setInputActive(snapshot.phase !== 'lobby');
    // M2.6 §3 — no deadball mode reset: the touch mode persists until the player
    // presses J/K/L. The HUD grid just reflects whatever the current mode is.
    this.viewController.setActive(FPV_PHASES.has(snapshot.phase));
    this.lastPhase = snapshot.phase;
    this.currentPhase = snapshot.phase;
    this.servingId = snapshot.servingId;

    // §5 — scoreboard serving dot needs the absolute side, independent of
    // whether this client's own player entry has spawned yet.
    const servingSide = snapshot.servingId ? findSide(snapshot, snapshot.servingId) : null;
    this.hud.setServingSide(servingSide ?? null);

    const ownEntry = snapshot.players.find((p) => p.id === room.sessionId);
    if (ownEntry) {
      this.ensureLocalPlayer(ownEntry);
      this.localPlayer?.reconcile(ownEntry);
      this.localCharacter?.setMode(ownEntry.mode);
      this.hud.setStamina(ownEntry.stamina);
    }

    for (const entry of snapshot.players) {
      if (entry.id === room.sessionId) continue;
      const remoteEntry = this.ensureRemotePlayer(entry.id, entry);
      remoteEntry.remote.pushSample(snapshot.serverTime, entry.pos);
      remoteEntry.facing = entry.facing; // §1 — remote facing target (interpolated)
      remoteEntry.character.setMode(entry.mode); // §2.3 — tint remotes too
      // M2.8 §3 — swing on the charge-release falling edge (facing-aimed). A real
      // contact's BallLaunch already fired a ball-aimed burst this instant;
      // triggerRemoteBurst's dedup window keeps it to one swing.
      if (remoteEntry.isCharging && !entry.isCharging) this.triggerRemoteBurst(remoteEntry, entry.mode);
      remoteEntry.isCharging = entry.isCharging;
    }

    this.currentServeHold = this.computeServeHold(snapshot);
    this.serveRender = this.computeServeRender(snapshot);
    const wasLocalServing = this.localServing;
    this.localServing = snapshot.phase === 'serve' && snapshot.servingId === room.sessionId;
    // M2.8 playtest §2 — on the rising edge of the local serve, re-face the FPV
    // camera at the net so the net-facing serve HUD matches what's rendered (a
    // stale rally yaw would otherwise mirror the shot in FPV only). Edge-only so
    // it never fights mouse-look during the serve.
    if (this.localServing && !wasLocalServing) this.viewController.faceNetForServe();
    this.hud.setServeActive(this.localServing);
    this.detectPlayerLeft(snapshot);
  }

  private computeServeHold(snapshot: StateSnapshot): ServeHold | null {
    if (snapshot.phase !== 'serve' || !snapshot.servingId) return null;
    const server = snapshot.players.find((p) => p.id === snapshot.servingId);
    if (!server) return null;
    return { pos: server.pos, side: server.side };
  }

  private computeServeRender(snapshot: StateSnapshot): ServeRender | null {
    if (snapshot.phase !== 'serve' || !snapshot.servingId) return null;
    const server = snapshot.players.find((p) => p.id === snapshot.servingId);
    if (!server) return null;
    const phaseStart = readServePhaseStart(snapshot);
    return { pos: server.pos, side: server.side, phaseStart };
  }

  private detectPlayerLeft(snapshot: StateSnapshot): void {
    const currentIds = new Set(snapshot.players.map((p) => p.id));
    const isInGamePhase = snapshot.phase === 'serve' || snapshot.phase === 'rally' || snapshot.phase === 'deadball';

    if (isInGamePhase) {
      for (const id of this.knownPlayerIds) {
        if (!currentIds.has(id)) {
          const name = this.playerNames.get(id) ?? 'A player';
          this.hud.showPlayerLeftNotice(name);
          const remoteEntry = this.remotePlayers.get(id);
          if (remoteEntry) {
            this.scene.scene.remove(remoteEntry.character.group);
            remoteEntry.character.dispose();
            this.remotePlayers.delete(id);
          }
        }
      }
    }

    this.knownPlayerIds = currentIds;
    for (const player of snapshot.players) this.playerNames.set(player.id, player.name);
  }

  private ensureLocalPlayer(entry: PlayerSnapshot): void {
    if (this.localPlayer) return;
    this.localSide = entry.side;
    this.localPlayer = new LocalPlayer(entry.pos, entry.side);
    this.localFacing = initialFacing(entry.side);
    this.localCharacter = new PlayerCharacter(entry.name, true, this.localFacing);
    this.scene.scene.add(this.localCharacter.group);
    // §6 — attach the FPV viewmodel (own arms) to the render camera.
    this.localCharacter.attachFpvViewmodel(this.scene.camera);
    this.scene.setCameraForSide(this.localSide);
    this.viewController.setSide(this.localSide);
  }

  private ensureRemotePlayer(id: string, entry: PlayerSnapshot): RemoteEntry {
    let remoteEntry = this.remotePlayers.get(id);
    if (!remoteEntry) {
      const character = new PlayerCharacter(entry.name, false, entry.facing);
      this.scene.scene.add(character.group);
      remoteEntry = {
        remote: new RemotePlayer(entry.pos),
        character,
        facing: entry.facing,
        prevPos: null,
        side: entry.side,
        isCharging: entry.isCharging, // M2.8 §1 — seed from first snapshot (no false release edge)
        lastTouchBurstMs: 0,
      };
      this.remotePlayers.set(id, remoteEntry);
    }
    return remoteEntry;
  }
}

function findSide(snapshot: StateSnapshot, id: string): Side | undefined {
  return snapshot.players.find((p) => p.id === id)?.side;
}

function vecOf(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function readServePhaseStart(snapshot: StateSnapshot): number | null {
  const value = (snapshot as { servePhaseStartServerTime?: unknown }).servePhaseStartServerTime;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
