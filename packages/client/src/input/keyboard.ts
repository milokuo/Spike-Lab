import { CHARGE_RATE, OVERCHARGE_MAX, type Axis, type TouchMode } from '@spike/shared';

export interface InputSample {
  move: { x: Axis; y: Axis };
  jumpHeld: boolean; // Space held this frame (M2.2 §1.4 — streamed every InputFrame)
  touchMode: TouchMode; // current J/K/L mode (M2.2 §2.2 — streamed every InputFrame)
  isCharging: boolean; // M2.8 §1 — H (or FPV LMB) held this frame; streamed every InputFrame
}

// Emitted on H-KEY release (M2.2 §2.1, rebound from LMB): the touch executes
// at the moment the key is let go — mode, charge, dirInput and clientTime are
// all sampled at that instant.
export interface RawTouchEvent {
  clientTime: number; // release instant (§2.1 — decides f_timing Δt)
  mode: TouchMode; // current touchMode at release
  charge: number; // 0..1, CHARGE_RATE accumulation while the key was held
  dirInput: { x: Axis; y: Axis }; // WASD state at release (view-local; server runs viewToWorld)
}

type TouchListener = (event: RawTouchEvent) => void;
type JumpPressListener = () => void;

const KEY_TO_MODE: Record<string, TouchMode> = { j: 'dig', k: 'set', l: 'spike' };
const LEFT_KEYS = new Set(['a', 'arrowleft']);
const RIGHT_KEYS = new Set(['d', 'arrowright']);
const FORWARD_KEYS = new Set(['w', 'arrowup']);
const BACK_KEYS = new Set(['s', 'arrowdown']);
const JUMP_KEY = ' ';
const CHARGE_KEY = 'h';
const DEFAULT_MODE: TouchMode = 'dig';

// M2.7 §8 — the 3×3 skill/mode grid as a linear selection sequence. Wheel steps
// ±1 (wrapping); Q/E jump rows keeping the column. The 發球 cell is NOT in the
// sequence (not selectable). Indices 3/4/5 are the J/K/L touch modes — landing
// on one switches touchMode; any other cell only moves the selection highlight.
const SKILL_SEQUENCE = ['u', 'i', 'o', 'j', 'k', 'l', 'm', ',', '.'] as const;
const SEQUENCE_LEN = SKILL_SEQUENCE.length;
const GRID_COLS = 3;
const SEQUENCE_MODE: Record<number, TouchMode> = { 3: 'dig', 4: 'set', 5: 'spike' };
const MODE_SEQUENCE_INDEX: Record<TouchMode, number> = { dig: 3, set: 4, spike: 5 };
const DEFAULT_SELECTION_INDEX = MODE_SEQUENCE_INDEX[DEFAULT_MODE];

// Unified keyboard controller (M2.2 §1/§2):
//   Space  — press-to-jump (rising edge starts the jump; held state streamed
//            every frame so holding extends the rise, per kinematics/jump.ts).
//   J/K/L  — switch touchMode instantly (allowed anytime, incl. while charging).
//   H      — hold to charge (CHARGE_RATE), release to execute a touch/serve.
//            (Rebound from LMB — mouse no longer drives charge/serve; mouse is
//            still used for FPV mouselook via ViewController.)
// The old J/K/L press-charge-release touch flow and the Space charge-jump flow
// are both gone (superseded per §1/§2).
export class KeyboardInput {
  private held = new Set<string>();
  private touchMode: TouchMode = DEFAULT_MODE;
  private selectionIndex = DEFAULT_SELECTION_INDEX; // §8 wheel/Q-E selected cell
  private chargeKeyDownAtMs: number | null = null;
  private touchListeners: TouchListener[] = [];
  private jumpPressListeners: JumpPressListener[] = [];
  private inputActive = false; // false while in lobby phase — ignores H-charge/jump

  constructor() {
    window.addEventListener('keydown', (event) => this.handleKeyDown(event));
    window.addEventListener('keyup', (event) => this.handleKeyUp(event));
    // §8 — wheel selects over the 9-grid (both views); passive (never scrolls).
    window.addEventListener('wheel', (event) => this.handleWheel(event), { passive: true });
    // Suppress the browser context menu so right-click never interrupts play.
    window.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  onTouch(listener: TouchListener): void {
    this.touchListeners.push(listener);
  }

  // §4 — drop all per-room touch/jump listeners as part of the single room
  // teardown, so re-wiring a fresh room doesn't accumulate duplicates that
  // still fire at the previous (dead) room.
  clearListeners(): void {
    this.touchListeners = [];
    this.jumpPressListeners = [];
  }

  // Fired on the Space keydown rising edge (once per press) — the local jump
  // prediction starts immediately (§1.4).
  onJumpPress(listener: JumpPressListener): void {
    this.jumpPressListeners.push(listener);
  }

  // Gates H-charge and jump on the match being live: while phase === 'lobby'
  // input is inert (§2.1). A pending charge is cancelled when input is
  // disabled so it can't fire a stray serve on unlock.
  setInputActive(active: boolean): void {
    this.inputActive = active;
    if (!active) this.chargeKeyDownAtMs = null;
  }

  // §2 (FPV re-lock) — called by ViewController when it swallows a canvas
  // mousedown to re-request pointer lock. Kept as a defensive hook so any
  // in-flight charge is cleared on re-lock; charge is driven by the H key
  // (not the mouse), so this is now just a safety net rather than a fix for
  // a mouse up/down mismatch.
  cancelPendingCharge(): void {
    this.chargeKeyDownAtMs = null;
  }

  // M2.7 §8 — H-equivalent charge start/release, driven by the H key AND (in
  // FPV+locked) the left mouse button via ViewController. Idempotent start so a
  // held H plus an LMB press don't stack two charges.
  startCharge(): void {
    if (!this.inputActive || this.chargeKeyDownAtMs !== null) return;
    this.chargeKeyDownAtMs = performance.now();
  }

  releaseCharge(): void {
    if (this.chargeKeyDownAtMs === null) return;
    const charge = this.chargeFrom(this.chargeKeyDownAtMs);
    this.chargeKeyDownAtMs = null;
    if (!this.inputActive) return;
    const touchEvent: RawTouchEvent = {
      clientTime: performance.now(), // §2.1 — Δt judged at the release instant
      mode: this.touchMode,
      charge,
      dirInput: this.sampleDirInput(),
    };
    for (const listener of this.touchListeners) listener(touchEvent);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === JUMP_KEY) event.preventDefault(); // stop the page from scrolling on Space
    if (this.held.has(key)) return; // ignore OS key-repeat (also guards H while already charging)
    this.held.add(key);

    if (key === JUMP_KEY && this.inputActive) {
      for (const listener of this.jumpPressListeners) listener();
    }

    if (key === CHARGE_KEY) this.startCharge();

    // §8 — Q/E jump the selection up/down a row keeping the column.
    if (key === 'q') this.jumpRow(-1);
    else if (key === 'e') this.jumpRow(1);

    const mode = KEY_TO_MODE[key];
    if (mode) {
      // §2.1 — instant switch, allowed while charging; §8 — sync selected cell.
      this.touchMode = mode;
      this.selectionIndex = MODE_SEQUENCE_INDEX[mode];
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    this.held.delete(key);
    if (key === CHARGE_KEY) this.releaseCharge();
  }

  // §8 — wheel-down = next cell, wheel-up = prev cell, wrapping both ends.
  private handleWheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;
    this.stepSelection(event.deltaY > 0 ? 1 : -1);
  }

  private stepSelection(delta: number): void {
    this.setSelection(this.selectionIndex + delta);
  }

  private jumpRow(rowDelta: number): void {
    const col = this.selectionIndex % GRID_COLS;
    const row = Math.floor(this.selectionIndex / GRID_COLS);
    const rows = SEQUENCE_LEN / GRID_COLS;
    const newRow = ((row + rowDelta) % rows + rows) % rows;
    this.setSelection(newRow * GRID_COLS + col);
  }

  // §8 — set the selected cell (wrapping); landing on J/K/L switches touchMode,
  // any other cell only moves the highlight (touchMode keeps its last J/K/L).
  private setSelection(index: number): void {
    const wrapped = ((index % SEQUENCE_LEN) + SEQUENCE_LEN) % SEQUENCE_LEN;
    this.selectionIndex = wrapped;
    const mode = SEQUENCE_MODE[wrapped];
    if (mode) this.touchMode = mode;
  }

  // §5 — charge accumulates past 1.0 into the red overcharge zone, capped at
  // OVERCHARGE_MAX (server re-validates/clamps to the same bound).
  private chargeFrom(pressedAtMs: number): number {
    const heldSeconds = (performance.now() - pressedAtMs) / 1000;
    return Math.min(OVERCHARGE_MAX, heldSeconds * CHARGE_RATE);
  }

  private sampleDirInput(): { x: Axis; y: Axis } {
    let x: Axis = 0;
    let y: Axis = 0;
    if (this.anyHeld(LEFT_KEYS)) x = -1;
    else if (this.anyHeld(RIGHT_KEYS)) x = 1;
    if (this.anyHeld(FORWARD_KEYS)) y = 1;
    else if (this.anyHeld(BACK_KEYS)) y = -1;
    return { x, y };
  }

  private anyHeld(keys: Set<string>): boolean {
    for (const key of keys) if (this.held.has(key)) return true;
    return false;
  }

  // Per-frame input snapshot for the InputFrame builder (move + jumpHeld +
  // touchMode all reported every frame, §1.4/§2.2).
  sample(): InputSample {
    return {
      move: this.sampleDirInput(),
      jumpHeld: this.inputActive && this.held.has(JUMP_KEY),
      touchMode: this.touchMode,
      isCharging: this.isCharging(),
    };
  }

  isJumpHeld(): boolean {
    return this.inputActive && this.held.has(JUMP_KEY);
  }

  // M2.8 §1 — is a charge in flight this frame? True while H (or, in FPV+locked,
  // the left mouse button) is held; both drive chargeKeyDownAtMs. Streamed in
  // every InputFrame so any client can render this player's charge-up pose.
  isCharging(): boolean {
    return this.chargeKeyDownAtMs !== null;
  }

  currentTouchMode(): TouchMode {
    return this.touchMode;
  }

  // §8 — the wheel/Q-E selected cell index (0..8 over SKILL_SEQUENCE), pushed to
  // the HUD each frame for the "selected cell" highlight.
  currentSelectionIndex(): number {
    return this.selectionIndex;
  }

  // Live charge (0..1) for the HUD charge bar while H is held, else 0.
  currentCharge(): number {
    return this.chargeKeyDownAtMs === null ? 0 : this.chargeFrom(this.chargeKeyDownAtMs);
  }
}
