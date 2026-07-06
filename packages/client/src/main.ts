import type { Room } from 'colyseus.js';
import { Connection } from './net/connection';
import { ClockSync } from './net/clockSync';
import { sendRequestSlot, sendSetMap, sendSetName, sendSetTeamName, sendStartMatch } from './net/messages';
import { SceneRenderer } from './scene/renderer';
import { buildCourt } from './scene/court';
import { BallView } from './scene/ball';
import { KeyboardInput } from './input/keyboard';
import { Hud } from './hud/hud';
import { LobbyView } from './lobby/lobbyView';
import { GameSession } from './app/gameSession';
import { ViewController } from './view/viewController';
import { DEBUG_GRID_KEY, DEFAULT_PLAYER_NAME, LOBBY_NAME_STORAGE_KEY, ROOM_MODE_PRACTICE } from './config';

// Bootstrap: build the scene once, then drive everything else through the
// MENU -> WAITING -> IN_GAME -> GAMEOVER -> MENU lobby flow (M2.1 §d). The
// game loop always runs (cheap with an empty court); LobbyView's own
// full-screen overlay covers it until a match actually starts.
async function bootstrap(): Promise<void> {
  const sceneRoot = document.getElementById('scene-root');
  const hudRoot = document.getElementById('hud-root');
  const lobbyRoot = document.getElementById('lobby-root');
  if (!sceneRoot || !hudRoot || !lobbyRoot) {
    throw new Error('index.html is missing #scene-root, #hud-root, or #lobby-root mount points');
  }

  const sceneRenderer = new SceneRenderer(sceneRoot);
  sceneRenderer.setCameraForSide('A'); // sane default before we know our side

  const court = buildCourt();
  sceneRenderer.scene.add(court.group);
  let debugGridVisible = false;
  const ballView = new BallView();
  // §3 jump-serve afterimage + M2.6 §4 ground blob shadow.
  sceneRenderer.scene.add(ballView.mesh, ballView.trailGroup, ballView.shadow);

  const keyboard = new KeyboardInput();
  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== DEBUG_GRID_KEY) return;
    debugGridVisible = !debugGridVisible;
    court.setDebugGridVisible(debugGridVisible);
  });

  const connection = new Connection();
  const clockSync = new ClockSync();
  const hud = new Hud(hudRoot, {
    onRetry: () => void retryLastAttempt(),
    // M2.9 §5 — the practice-mode HUD chip's 離開 button: full teardown → menu.
    onLeavePractice: () => leaveToMenu(),
  });
  connection.onStatus((status) => hud.setConnectionStatus(status));

  const savedName = localStorage.getItem(LOBBY_NAME_STORAGE_KEY) ?? DEFAULT_PLAYER_NAME;
  let lastAttempt: (() => Promise<void>) | undefined;

  const lobbyView = new LobbyView(lobbyRoot, savedName, {
    onCreate: (name) => void attempt(() => createRoom(name)),
    onJoin: (code, name) => void attempt(() => joinRoom(code, name)),
    onPractice: (name) => void attempt(() => createPracticeRoom(name)),
    onStart: () => {
      const room = connection.room;
      if (room) sendStartMatch(room);
    },
    onRequestSlot: (side, index) => {
      const room = connection.room;
      if (room) sendRequestSlot(room, { side, index });
    },
    onSetMap: (map) => {
      const room = connection.room;
      if (room) sendSetMap(room, { map });
    },
    onSetTeamName: (name) => {
      const room = connection.room;
      if (room) sendSetTeamName(room, { name });
    },
    onLeaveToMenu: () => leaveToMenu(),
  });

  // M2.3 §5 / M2.4 §2 — FPV controller: owns the V toggle, pointer lock, and
  // mouselook. On involuntary lock loss it stays in FPV and shows the "click to
  // restore" prompt; only a hard pointerlockerror falls back to third person.
  const viewController = new ViewController(
    sceneRenderer.renderer.domElement,
    {
      showRevertNotice: (text) => hud.showViewNotice(text),
      setLockPrompt: (visible) => hud.setFpvLockPrompt(visible),
    },
    keyboard,
  );
  const gameSession = new GameSession(sceneRenderer, ballView, hud, lobbyView, viewController, court);

  function persistName(name: string): void {
    localStorage.setItem(LOBBY_NAME_STORAGE_KEY, name);
  }

  async function createRoom(name: string): Promise<void> {
    persistName(name);
    const room = await connection.createRoom();
    onRoomJoined(room, name, false);
  }

  // M2.9 §5 — practice sandbox: create with the fixed { mode: 'practice' } wire
  // option and enter with the client-local isPractice flag set (self-created
  // room, so we know without any wire signal).
  async function createPracticeRoom(name: string): Promise<void> {
    persistName(name);
    const room = await connection.createRoom({ mode: ROOM_MODE_PRACTICE });
    onRoomJoined(room, name, true);
  }

  async function joinRoom(code: string, name: string): Promise<void> {
    persistName(name);
    const room = await connection.joinRoomByCode(code);
    onRoomJoined(room, name, false);
  }

  function onRoomJoined(room: Room, name: string, isPractice: boolean): void {
    // §4 — rebuild from a clean slate on EVERY room entry (single teardown).
    // Guards the retry-after-disconnect path, which reaches here without an
    // explicit leave and would otherwise leak the previous match's meshes and
    // duplicate keyboard listeners into the new room.
    gameSession.reset();
    clockSync.start(room);
    gameSession.wireRoom(room, keyboard, isPractice);
    sendSetName(room, { name });
    // §5 — practice skips the waiting room and shows a "進入練習場…" card until
    // the sandbox auto-starts into the serve phase; versus shows the code.
    if (isPractice) lobbyView.showPracticeTransition();
    else lobbyView.showWaitingPlaceholder(room.roomId);
  }

  async function attempt(action: () => Promise<void>): Promise<void> {
    lastAttempt = action;
    try {
      await action();
    } catch (error: unknown) {
      // Status already surfaced via connection.onStatus -> hud overlay; the
      // lobby screen also gets an inline, human-readable reason.
      lobbyView.showError(describeJoinError(error));
      console.error('Failed to join/create room:', error);
    }
  }

  async function retryLastAttempt(): Promise<void> {
    if (lastAttempt) await attempt(lastAttempt);
  }

  function leaveToMenu(): void {
    connection.disconnect();
    clockSync.stop();
    gameSession.reset();
    lobbyView.showMenu();
  }

  let lastFrameMs = performance.now();

  function animate(nowMs: number): void {
    requestAnimationFrame(animate);
    const dtMs = nowMs - lastFrameMs;
    lastFrameMs = nowMs;

    // M2.3 §1 — the SERVE_MIN_CHARGE floor is gone: the charge bar always shows
    // the raw value from 0 (an under-charged serve is allowed to fail naturally).
    hud.setCharge(keyboard.currentCharge());

    if (hud.isHitstopActive(nowMs)) {
      sceneRenderer.render();
      return;
    }

    gameSession.tickJump(dtMs, keyboard.isJumpHeld());

    const room = connection.room;
    if (room) gameSession.pumpInput(room, keyboard, dtMs);

    const serverTimeNow = clockSync.isSynced() ? clockSync.serverTimeNow() : undefined;
    gameSession.updateVisuals(dtMs, serverTimeNow);

    // §4 — idle menu orbit ONLY while no room is joined. The instant a room
    // exists, updateVisuals (followPlayer / FPV) owns the camera and orbit never
    // runs, so there is no hand-off fight on the enter→leave→enter cycle.
    if (!room) sceneRenderer.orbitIdle(nowMs);

    sceneRenderer.render();
  }

  requestAnimationFrame(animate);
}

function describeJoinError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/not found|invalid room/i.test(message)) return 'Room not found. Check the code and try again.';
  if (/full|locked/i.test(message)) return 'That room is full.';
  return 'Could not reach the server. Check your connection and try again.';
}

bootstrap().catch((error: unknown) => {
  console.error('Fatal client bootstrap error:', error);
  const hudRoot = document.getElementById('hud-root');
  if (hudRoot) {
    hudRoot.innerHTML =
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-family:sans-serif;background:#0a0a12;">Failed to start Spike Lab. Check the console for details.</div>';
  }
});
