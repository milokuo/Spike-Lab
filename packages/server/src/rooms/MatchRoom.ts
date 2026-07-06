// Authoritative match room (plan §5 WP2 + M2.1 §d, M2.2 §1-§4). Networking +
// lobby layer: owns the 30Hz tick loop, the code-based lobby (up to 4 players,
// auto-balanced sides, host-started), movement + variable-jump integration,
// authoritative touch-mode, dive application, and broadcasting. The physical
// rally (ball, lag-comp, serve, scoring, dive roll) lives in MatchSim so this
// file stays focused on Colyseus concerns. The ball is never in schema (§0).
import { Room, type Client } from 'colyseus';
import {
  CH,
  ROOM_NAME,
  TICK_MS,
  COURT_HALF_LENGTH,
  STAMINA_DEADBALL_RECOVER,
  STAMINA_MAX,
  JUMP_STAMINA_BASE,
  JUMP_BOOST_MAX_S,
  DIVE_STAMINA,
  computeFacing,
  currentServerId,
  gradeOf,
  initialFacing,
  initRotation,
  isLanded,
  jumpHoldStaminaCost,
  onPoint,
  removePlayer,
  startJump,
  stepJump,
  ROOM_MODE_PRACTICE,
  type DeathEvent,
  type JumpState,
  type LobbyState,
  type MapId,
  type ServeRotation,
  type Side,
  type TeamNames,
  type TouchIntent,
  type TouchResult,
  type Vec3,
} from '@spike/shared';
import { MatchState } from './schema/MatchState';
import { PlayerState } from './schema/PlayerState';
import { HOST, MAX_CLIENTS, receiveSpawn } from '../config';
import { applyInput } from '../sim/movement';
import { parseInput, parsePing, parseTouch, parseSetName, parseRequestSlot, parseSetMap, parseSetTeamName } from '../net/validate';
import { autoAssignSlot, buildLobbyState, canStart, defaultName, isSlotFree } from './lobby';
import { buildRoster, buildSnapshot } from './wire';
import { MatchSim, RESET_DELAY, type DiveResult } from './matchSim';

const TOUCH_STAMINA_COST = 5; // spec §7.1: 5 per touch (a dive spends DIVE_STAMINA instead)
// M2.7 §1 (finding #3): safety bound on chained net/rebound resolutions per tick.
const MAX_NET_RESOLVES_PER_TICK = 8;
// M2.7 §5 — default team names ("A 隊" / "B 隊").
const DEFAULT_TEAM_NAME_A = 'A 隊';
const DEFAULT_TEAM_NAME_B = 'B 隊';
// Deferred so the joining client's onMessage handlers are registered before the
// first LOBBY_STATE arrives (Colyseus delivers onJoin broadcasts immediately).
const LOBBY_BROADCAST_DELAY_MS = 60;
// M2.9 §2 — practice sandbox auto-starts this long after the lone player joins.
// MUST be later than LOBBY_BROADCAST_DELAY_MS so the client sees the lobby snapshot
// (and registers its handlers) before the room jumps straight into serve phase.
const PRACTICE_AUTOSTART_MS = 300;

// M2.9 §1 — defensive room-mode parse: ONLY the exact { mode: 'practice' } wire
// literal selects the practice sandbox. Missing / unknown / malformed options
// (including a non-object) fall through to a normal versus room — never throws.
function parsePracticeMode(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) return false;
  return (options as { mode?: unknown }).mode === ROOM_MODE_PRACTICE;
}

export class MatchRoom extends Room<MatchState> {
  maxClients = MAX_CLIENTS;

  private readonly sim = new MatchSim();
  // M2.2 §1: per-player variable-jump state. `null` = grounded (not mid-jump);
  // a JumpState means airborne. Rising edge of jumpHeld starts a jump.
  private readonly jumpStates = new Map<string, JumpState | null>();
  private readonly lastJumpHeld = new Map<string, boolean>(); // for rising-edge detection
  private readonly moveLockUntil = new Map<string, number>(); // §3.2 dive movement lock (epoch ms)
  // M2.3 §3.1 — server clock at which the current serve phase began. Broadcast in
  // every snapshot (while serving) and fed to MatchSim.serve so the authoritative
  // protractor angle = sweepAngleDeg(lagCompRelease − servePhaseStartMs).
  private servePhaseStartMs = 0;
  private seatCounter = 0;
  // M2.6 §2 — per-team serve rotation, built at match start (null in lobby).
  private rotation: ServeRotation | null = null;
  // M2.9 §2 — practice sandbox flag (single-seat private room). Set once in
  // onCreate from the create options; versus rooms leave it false.
  private isPractice = false;

  onCreate(options?: unknown): void {
    // M2.9 §1/§2 — practice sandbox = a private, single-seat room. joinById then
    // fails so a shared room code can't accidentally pull a friend into someone's
    // practice court. A versus room (default) keeps the full 12-seat public lobby.
    this.isPractice = parsePracticeMode(options);
    if (this.isPractice) {
      this.maxClients = 1;
      void this.setPrivate(true);
    }
    const state = new MatchState();
    state.scoreA = 0;
    state.scoreB = 0;
    state.phase = 'lobby';
    state.servingId = '';
    state.hostId = '';
    state.map = 'indoor'; // M2.7 §4 — default map
    state.teamNameA = DEFAULT_TEAM_NAME_A; // M2.7 §5
    state.teamNameB = DEFAULT_TEAM_NAME_B;
    this.setState(state);
    this.registerHandlers();
    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  // ---- lifecycle ----------------------------------------------------------

  onJoin(client: Client): void {
    // M2.6 §1 — seat the joiner in the fewer-team's lowest empty slot (tie -> A).
    const roster = [...this.state.players.values()].map((p) => ({ side: p.side, slotIndex: p.slotIndex }));
    const assigned = autoAssignSlot(roster) ?? { side: 'A' as Side, index: 0 };
    const side = assigned.side;
    const sameSide = this.countSide(side);
    const spawn = receiveSpawn(side, assigned.index, sameSide + 1);

    const player = new PlayerState();
    player.id = client.sessionId;
    player.side = side;
    player.slotIndex = assigned.index; // M2.6 §1
    player.name = defaultName(++this.seatCounter);
    player.x = spawn.x;
    player.y = 0;
    player.z = spawn.z;
    player.stamina = STAMINA_MAX;
    player.mode = 'dig'; // M2.2 §2.1 — default touch mode
    player.isCharging = false; // M2.8 §1 — default not charging
    player.lastProcessedSeq = 0;
    player.facing = initialFacing(side); // M2.5 §1 — spawn facing the net
    this.state.players.set(client.sessionId, player);
    this.jumpStates.set(client.sessionId, null); // grounded
    this.lastJumpHeld.set(client.sessionId, false);
    this.moveLockUntil.set(client.sessionId, 0);

    if (this.state.hostId === '') this.state.hostId = client.sessionId;
    // Defer so the new client's handlers exist before this first send.
    this.clock.setTimeout(() => this.broadcastLobbyState(), LOBBY_BROADCAST_DELAY_MS);

    // M2.9 §2 — practice: auto-start the sandbox shortly after the lobby snapshot
    // (no host, no START_MATCH). maxClients=1 means exactly one join => one timer.
    if (this.isPractice) {
      this.clock.setTimeout(() => this.startPractice(), PRACTICE_AUTOSTART_MS);
    }
  }

  onLeave(client: Client): void {
    const wasHost = this.state.hostId === client.sessionId;
    const wasServing = this.state.servingId === client.sessionId;
    this.state.players.delete(client.sessionId);
    this.jumpStates.delete(client.sessionId);
    this.lastJumpHeld.delete(client.sessionId);
    this.moveLockUntil.delete(client.sessionId);
    this.sim.forget(client.sessionId);
    // M2.6 §2 — drop the leaver from the rotation order (idx fixed modulo).
    if (this.rotation) this.rotation = removePlayer(this.rotation, client.sessionId);
    if (wasHost) this.promoteHost();

    // M2.9 §2 — practice: the lone player leaving must NOT forfeit (there is no
    // opponent). The now-empty room is collected by Colyseus autoDispose.
    if (this.isPractice) return;

    if (this.state.phase === 'lobby' || this.state.phase === 'gameover') {
      this.broadcastLobbyState();
      return;
    }
    // Mid-match leave (§d): forfeit if a side is now empty, else short-handed.
    if (this.countSide('A') === 0 || this.countSide('B') === 0) {
      this.sim.forfeit(this.state);
      this.broadcastSnapshot(Date.now());
    } else if (wasServing) {
      // M2.6 §2 — the serving player left: the rotation resolves the replacement.
      const next = this.rotation ? currentServerId(this.rotation) : '';
      this.state.servingId = next || this.anyPlayerId() || '';
    }
  }

  private promoteHost(): void {
    const next = this.state.players.keys().next(); // lowest remaining seat
    this.state.hostId = next.done ? '' : next.value;
  }

  // ---- message handlers ---------------------------------------------------

  private registerHandlers(): void {
    this.onMessage(CH.PING, (client, raw) => {
      const ping = parsePing(raw);
      if (!ping) return;
      const serverTime = Date.now();
      this.sim.observePing(client.sessionId, ping.clientTime, serverTime);
      client.send(CH.PONG, { clientTime: ping.clientTime, serverTime });
    });

    this.onMessage(CH.SET_NAME, (client, raw) => {
      const parsed = parseSetName(raw);
      if (!parsed) return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.name = parsed.name;
      this.broadcastLobbyState();
    });

    // M2.6 §1 — move self to an empty team slot. Lobby phase only; the target
    // must be free, else the request is silently ignored (no error to client).
    this.onMessage(CH.REQUEST_SLOT, (client, raw) => {
      const req = parseRequestSlot(raw);
      if (!req) return;
      if (this.state.phase !== 'lobby') return; // lobby-only
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const roster = [...this.state.players.values()]
        .filter((p) => p.id !== client.sessionId) // ignore self so a no-op move to own slot is allowed-through-empty
        .map((p) => ({ side: p.side, slotIndex: p.slotIndex }));
      if (!isSlotFree(roster, req.side, req.index)) return; // occupied -> silent ignore
      player.side = req.side;
      player.slotIndex = req.index;
      this.broadcastLobbyState();
    });

    // M2.7 §4 — CH.SET_MAP: host-only, lobby phase only. Validated to a known
    // MapId in parseSetMap; anything else is dropped.
    this.onMessage(CH.SET_MAP, (client, raw) => {
      const parsed = parseSetMap(raw);
      if (!parsed) return;
      if (client.sessionId !== this.state.hostId) return; // host-only
      if (this.state.phase !== 'lobby') return; // lobby-only
      this.state.map = parsed.map;
      this.broadcastLobbyState();
    });

    // M2.7 §5 — CH.SET_TEAM_NAME: captain-only. The server infers which side from
    // the sender (a player must be that side's captain) and renames that side.
    this.onMessage(CH.SET_TEAM_NAME, (client, raw) => {
      const parsed = parseSetTeamName(raw);
      if (!parsed) return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (this.captainOf(player.side) !== client.sessionId) return; // captain-only
      if (player.side === 'A') this.state.teamNameA = parsed.name;
      else this.state.teamNameB = parsed.name;
      this.broadcastLobbyState();
    });

    this.onMessage(CH.START_MATCH, (client) => {
      if (client.sessionId !== this.state.hostId) return; // host-only
      if (this.state.phase !== 'lobby' && this.state.phase !== 'gameover') return;
      if (!canStart(buildRoster(this.state))) return;
      this.startMatch();
    });

    this.onMessage(CH.INPUT, (client, raw) => {
      const input = parseInput(raw);
      if (!input) return;
      const player = this.state.players.get(client.sessionId);
      if (!player || input.seq <= player.lastProcessedSeq) return; // stale / replay

      // §2.1: touch mode is switchable at ANY time (even mid-lunge) and takes
      // effect immediately — write the authoritative mode every frame.
      player.mode = input.touchMode;
      // M2.8 §1: charge-hold state is authoritative from the client's per-frame
      // report — write it every frame so any client can render any player's
      // charge-up.
      player.isCharging = input.isCharging;

      // §3.2: movement (and jump start) are locked during a dive recovery.
      const locked = Date.now() < (this.moveLockUntil.get(player.id) ?? 0);

      // M2.5 §1 — facing priority: explicit yaw > movement direction > previous
      // facing. While movement is dive-locked the player isn't actually moving,
      // so the movement-direction path is suppressed (yaw can still turn the
      // player; idle/locked otherwise keeps the last facing).
      const facingMove = locked ? { x: 0, y: 0 } : input.move;
      player.facing = computeFacing(player.facing, player.side, facingMove, input.yaw);

      if (!locked) {
        // §2: a GROUNDED server, ball not yet launched, may not enter the court.
        const grounded = this.jumpStates.get(player.id) == null;
        const serveClampAbsZ =
          this.state.phase === 'serve' && client.sessionId === this.state.servingId && grounded
            ? COURT_HALF_LENGTH
            : undefined;
        const next = applyInput(
          { pos: player, stamina: player.stamina, side: player.side, serveClampAbsZ },
          input,
        );
        player.x = next.pos.x;
        player.z = next.pos.z;
        player.stamina = next.stamina;
        this.tryStartJump(player, input.jumpHeld);
      }
      this.lastJumpHeld.set(player.id, input.jumpHeld);
      player.lastProcessedSeq = input.seq;
    });

    this.onMessage(CH.TOUCH, (client, raw) => {
      const intent = parseTouch(raw);
      if (!intent || intent.playerId !== client.sessionId) return; // anti-spoof
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      if (this.state.phase === 'serve' && client.sessionId === this.state.servingId) {
        const { launch, isJump } = this.sim.serve(player, intent, this.servePhaseStartMs);
        // §3.3: a jump serve costs ×2 serve stamina.
        player.stamina = Math.max(0, player.stamina - TOUCH_STAMINA_COST * (isJump ? 2 : 1));
        this.state.phase = 'rally';
        this.broadcast(CH.BALL_LAUNCH, launch);
        this.sendTouchResult(client, true, launch.quality, launch.serverTime);
      } else if (this.state.phase === 'rally') {
        this.handleRallyTouch(client, player, intent);
      }
    });
  }

  private handleRallyTouch(client: Client, player: PlayerState, intent: TouchIntent): void {
    const canAffordDive = player.stamina >= DIVE_STAMINA; // §3.2: else no dive, plain whiff
    const outcome = this.sim.rallyTouch(
      client.sessionId,
      player,
      intent,
      this.teammatePositions(player.id, player.side),
      canAffordDive,
      this.isPractice, // M2.9 §2 — bypass legality gate so the sandbox player can juggle
    );
    // A dive lunges + locks + spends DIVE_STAMINA regardless of success/failure.
    if (outcome.dive) this.applyDive(player, outcome.dive);
    const diveOutcome = outcome.dive?.outcome;

    // M2.7 §2 — an illegal touch (double contact / count) is refused WITHOUT
    // ending the rally: the ball flies on. Send the specific rejection feedback.
    if (outcome.rejection) {
      this.sendTouchResult(client, false, 0, outcome.serverTime, undefined, outcome.rejection);
      return;
    }
    if (!outcome.accepted || !outcome.launch) {
      this.sendTouchResult(client, false, 0, outcome.serverTime, undefined, diveOutcome);
      return;
    }
    // A successful dive already paid DIVE_STAMINA; a normal touch pays the flat cost.
    if (!outcome.dive) player.stamina = Math.max(0, player.stamina - TOUCH_STAMINA_COST);
    this.broadcast(CH.BALL_LAUNCH, outcome.launch);
    this.sendTouchResult(client, true, outcome.quality, outcome.serverTime, outcome.deltaMs, diveOutcome);
  }

  // §3.2: apply the dive's physical effects to authoritative state — teleport the
  // player to the capped lunge point, spend stamina, lock movement, and cancel
  // any in-progress jump (the player is on the floor lunging, not airborne).
  private applyDive(player: PlayerState, dive: DiveResult): void {
    player.x = dive.lunge.x;
    player.z = dive.lunge.z;
    player.y = 0;
    player.stamina = Math.max(0, player.stamina - dive.staminaCost);
    this.moveLockUntil.set(player.id, dive.lockUntilMs);
    this.jumpStates.set(player.id, null);
  }

  // §1: rising-edge, grounded, stamina-gated jump start. Deducts JUMP_STAMINA_BASE
  // exactly once (per-tick hold cost is charged separately in integratePlayerJump).
  private tryStartJump(player: PlayerState, held: boolean): void {
    const prevHeld = this.lastJumpHeld.get(player.id) ?? false;
    const grounded = this.jumpStates.get(player.id) == null;
    if (held && !prevHeld && grounded && player.stamina >= JUMP_STAMINA_BASE) {
      this.jumpStates.set(player.id, startJump());
      player.stamina -= JUMP_STAMINA_BASE;
      player.y = 0;
    }
  }

  // ---- lobby / start ------------------------------------------------------

  private startMatch(): void {
    this.state.scoreA = 0;
    this.state.scoreB = 0;
    for (const p of this.state.players.values()) p.stamina = STAMINA_MAX;
    // M2.6 §2 — rotation order = slot-index ascending; side A idx 0 serves first.
    this.rotation = initRotation(this.orderForSide('A'), this.orderForSide('B'));
    this.state.servingId = currentServerId(this.rotation) || this.anyPlayerId() || '';
    this.enterServePhase();
  }

  // M2.9 §2 — practice variant of startMatch: a single-player sandbox. No rotation
  // (kept null), no canStart gate (auto-started, not host-clicked), the lone player
  // always serves. Guarded so a stray timer on an emptied/started room is a no-op.
  private startPractice(): void {
    const only = this.anyPlayerId();
    if (!only || this.state.phase !== 'lobby') return;
    this.state.scoreA = 0;
    this.state.scoreB = 0;
    for (const p of this.state.players.values()) p.stamina = STAMINA_MAX;
    this.rotation = null; // no serve rotation in the sandbox
    this.state.servingId = only;
    this.enterServePhase();
  }

  // M2.6 §2 — playerIds on `side`, slot-index ascending (the serve rotation order).
  private orderForSide(side: Side): string[] {
    return [...this.state.players.values()]
      .filter((p) => p.side === side)
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((p) => p.id);
  }

  // ---- 30Hz fixed simulation tick ----------------------------------------

  private tick(): void {
    const serverNow = Date.now();
    const dtS = TICK_MS / 1000;
    // Integrate variable jumps first (gravity pulls every tick, input or not),
    // then hand positions to the sim for lag-comp recording + event detection.
    for (const player of this.state.players.values()) {
      this.integratePlayerJump(player, dtS);
    }
    let due = this.sim.recordTick(this.state, serverNow);
    // M2.7 §1 — a net contact is NOT a death: resolve it into a new BallLaunch
    // (rebound or damped pass-over) from the exact contact and broadcast it.
    // Finding #3: drain net contacts AND any rebound landing that is ALREADY due
    // at this same instant, so a touch can never be accepted on an already-dead
    // trajectory in the sub-tick gap. Bounded to avoid a pathological loop.
    let guard = 0;
    while (due === 'net' && guard++ < MAX_NET_RESOLVES_PER_TICK) {
      const netLaunch = this.sim.resolveNet();
      if (!netLaunch) break;
      this.broadcast(CH.BALL_LAUNCH, netLaunch);
      due = this.sim.pollDueEvent(this.state, serverNow);
    }
    if (due && due !== 'net') {
      const pos = this.sim.eventPos();
      if (pos) this.finishRally(due, pos, this.sim.lastHitter(), serverNow);
    }
    this.broadcastSnapshot(serverNow);
  }

  // §1.1/§1.2: advance one airborne player. Boost (reduced gravity) applies only
  // while held, rising, and inside the boost window — and aborts when stamina
  // hits 0 (we pass held=false to stepJump so it reverts to full gravity). The
  // per-second hold cost is charged only while genuinely boosting. Landing
  // (y<=0 & vy<0) restores the grounded (null) state.
  private integratePlayerJump(player: PlayerState, dtS: number): void {
    const js = this.jumpStates.get(player.id);
    if (js == null) return; // grounded — nothing to integrate
    const held = this.lastJumpHeld.get(player.id) ?? false;
    const canBoost = held && player.stamina > 0;
    const boosting = canBoost && js.vy > 0 && js.airborneS <= JUMP_BOOST_MAX_S;
    const next = stepJump(js, dtS, canBoost);
    if (boosting) {
      player.stamina = Math.max(0, player.stamina - jumpHoldStaminaCost(dtS, true));
    }
    if (isLanded(next)) {
      this.jumpStates.set(player.id, null);
      player.y = 0;
    } else {
      this.jumpStates.set(player.id, next);
      player.y = next.y;
    }
  }

  private finishRally(
    kind: Parameters<MatchSim['endRally']>[1],
    landing: Vec3,
    side: Side,
    serverTime: number,
  ): void {
    const result = this.sim.endRally(this.state, kind, landing, side, serverTime, this.isPractice);
    if (!result) return;
    // M2.3 §3 (M2.6): dead ball does NOT reset touch mode — mode changes only via
    // an InputFrame (J/K/L). The old resetModes() call is removed.
    // M2.6 §2 — advance the serve rotation from the scoring side and publish the
    // resolved next server (both authoritative state and the DeathEvent). Practice
    // (§2) freezes scoring: endRally already stamped nextServerId = self, so skip.
    let death: DeathEvent = result.death;
    if (!this.isPractice && !result.gameover && this.rotation) {
      this.rotation = onPoint(this.rotation, death.scoringSide);
      const nextServer = currentServerId(this.rotation);
      this.state.servingId = nextServer;
      death = { ...death, nextServerId: nextServer };
    }
    this.broadcast(CH.DEATH, death satisfies DeathEvent);
    if (result.gameover) return;
    this.recoverStamina();
    this.clock.setTimeout(() => {
      if (this.state.phase === 'deadball') this.enterServePhase();
    }, RESET_DELAY);
  }

  private enterServePhase(): void {
    this.sim.enterServe(this.state); // positions players (incl. outside serve station)
    // §3.1: stamp the serve-phase start so both ends compute the same protractor
    // sweep from a common origin. Set AFTER enterServe flips phase to 'serve'.
    this.servePhaseStartMs = Date.now();
    for (const id of this.state.players.keys()) {
      this.jumpStates.set(id, null); // grounded
      this.lastJumpHeld.set(id, false);
      this.moveLockUntil.set(id, 0);
    }
  }

  // ---- helpers ------------------------------------------------------------

  private teammatePositions(selfId: string, side: Side): Vec3[] {
    return [...this.state.players.values()]
      .filter((p) => p.side === side && p.id !== selfId)
      .map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  private countSide(side: Side): number {
    let n = 0;
    for (const p of this.state.players.values()) if (p.side === side) n++;
    return n;
  }

  private recoverStamina(): void {
    for (const p of this.state.players.values()) {
      p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_DEADBALL_RECOVER);
    }
  }

  // M2.8 playtest — TouchResult is now BROADCAST to the whole room (was sent only
  // to the toucher) and carries the toucher's playerId, so every client can play
  // that player's happy/dazed face + dive lunge on both local and remote
  // characters. HUD text stays local-only via the playerId gate on the client.
  private sendTouchResult(
    client: Client,
    accepted: boolean,
    quality: number,
    serverTime: number,
    deltaMs?: number,
    outcome?: TouchResult['outcome'],
  ): void {
    const result: TouchResult = {
      playerId: client.sessionId,
      accepted,
      quality,
      grade: accepted ? gradeOf(deltaMs ?? 0) : 'WHIFF',
      serverTime,
      outcome,
    };
    this.broadcast(CH.TOUCH_RESULT, result);
  }

  // M2.7 §5 — captain of a side = its earliest-joined current member. The players
  // MapSchema preserves insertion (join) order, so the first member on that side
  // is the captain; returns null when the side is empty. Recomputed on demand, so
  // a captain leaving auto-promotes the next-earliest on the next broadcast.
  private captainOf(side: Side): string | null {
    for (const p of this.state.players.values()) if (p.side === side) return p.id;
    return null;
  }

  private broadcastLobbyState(): void {
    const teamNames: TeamNames = { A: this.state.teamNameA, B: this.state.teamNameB };
    const captains = { A: this.captainOf('A'), B: this.captainOf('B') };
    const lobby: LobbyState = buildLobbyState(
      this.roomId,
      this.state.hostId,
      buildRoster(this.state),
      this.state.map as MapId,
      captains,
      teamNames,
    );
    this.broadcast(CH.LOBBY_STATE, lobby);
  }

  private broadcastSnapshot(serverTime: number): void {
    this.broadcast(CH.SNAPSHOT, buildSnapshot(this.state, serverTime, this.servePhaseStartMs));
  }

  private anyPlayerId(): string | null {
    const first = this.state.players.keys().next();
    return first.done ? null : first.value;
  }
}

export const registerRoom = { name: ROOM_NAME, room: MatchRoom, host: HOST };
