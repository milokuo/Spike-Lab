import type { LobbyState, MapId, MatchPhase, ScoreState, Side, TeamSlot } from '@spike/shared';
import { injectLobbyStyles } from './lobbyStyles';
import { MenuScreen } from './menuScreen';
import { buildMapPicker, renderMapPicker } from './mapPicker';
import { buildTeamHeader } from './teamHeader';
import { computeChangedSlotKeys, slotKey } from './slotAnimation';

export interface LobbyCallbacks {
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  // M2.9 §5 — practice card: create a private single-player sandbox room.
  onPractice: (name: string) => void;
  onStart: () => void;
  // M2.6 §1 — click an empty slot to join/switch to team `side` at `index`.
  onRequestSlot: (side: Side, index: number) => void;
  // M2.7 §4 — host-only map pick.
  onSetMap: (map: MapId) => void;
  // M2.7 §5 — captain-only rename of their own side (server infers which side).
  onSetTeamName: (name: string) => void;
  onLeaveToMenu: () => void;
}

// Lobby orchestration: MENU (title/mode cards — MenuScreen) -> WAITING
// (roster/code/Start) -> (hidden during in-game) -> GAMEOVER, plus the M2.9 §5
// PRACTICE transition card. WAITING/GAMEOVER are reskinned to the SPIKE LAB
// palette (semi-transparent glass over the live court) but keep the exact slot
// grid / map picker / team header structure + class names (slotAnimation guard).
export class LobbyView {
  private root: HTMLElement;
  private callbacks: LobbyCallbacks;

  private menu: MenuScreen;

  private waitingScreen: HTMLElement;
  private codeDisplayEl: HTMLElement;
  private slotGridEl: HTMLElement;
  private mapPickerEl: HTMLElement;
  private startButton: HTMLButtonElement;
  private waitingHintEl: HTMLElement;

  private gameoverScreen: HTMLElement;
  private gameoverScoreEl: HTMLElement;

  // §5 — "進入練習場…" card shown from the practice-card click until the sandbox
  // leaves the lobby phase (setPhaseVisibility then hides the whole overlay).
  private transitionScreen: HTMLElement;
  // Practice keeps the transition card up through the brief phase==='lobby'
  // autostart window instead of flashing the waiting room (snapshots broadcast
  // every tick, including lobby — see MatchRoom.tick).
  private practiceActive = false;

  private latestLobbyState: LobbyState | undefined;

  constructor(root: HTMLElement, initialName: string, callbacks: LobbyCallbacks) {
    injectLobbyStyles();
    this.root = root;
    this.callbacks = callbacks;
    this.root.innerHTML = '';

    this.menu = new MenuScreen(initialName, {
      onPractice: (name) => callbacks.onPractice(name),
      onCreate: (name) => callbacks.onCreate(name),
      onJoin: (code, name) => callbacks.onJoin(code, name),
    });

    const { screen: waitingScreen, codeDisplay, slotGrid, mapPicker, start, hint } = this.buildWaitingScreen();
    this.waitingScreen = waitingScreen;
    this.codeDisplayEl = codeDisplay;
    this.slotGridEl = slotGrid;
    this.mapPickerEl = mapPicker;
    this.startButton = start;
    this.waitingHintEl = hint;

    const { screen: gameoverScreen, scoreEl } = this.buildGameOverScreen();
    this.gameoverScreen = gameoverScreen;
    this.gameoverScoreEl = scoreEl;

    this.transitionScreen = this.buildTransitionScreen();

    this.root.append(this.menu.element, this.waitingScreen, this.gameoverScreen, this.transitionScreen);
    this.showMenu();
  }

  // ---- screen construction -------------------------------------------------

  private buildWaitingScreen(): {
    screen: HTMLElement;
    codeDisplay: HTMLElement;
    slotGrid: HTMLElement;
    mapPicker: HTMLElement;
    start: HTMLButtonElement;
    hint: HTMLElement;
  } {
    const screen = document.createElement('div');
    screen.className = 'lobby-screen lobby-waiting';
    // Glass card wrapper (reskin) — holds the SAME elements/class names as
    // before so slotAnimation + mapPicker + teamHeader are untouched.
    const card = document.createElement('div');
    card.className = 'lobby-glass-card';

    const title = document.createElement('h1');
    title.className = 'lobby-title';
    title.textContent = '待戰室';

    const codeLabel = document.createElement('div');
    codeLabel.className = 'lobby-code-label';
    codeLabel.textContent = '房碼 — 分享給朋友：';

    const codeDisplay = document.createElement('div');
    codeDisplay.className = 'lobby-code-display';

    const copyButton = document.createElement('button');
    copyButton.className = 'lobby-button lobby-button-small';
    copyButton.textContent = '複製房碼';
    copyButton.addEventListener('click', () => void this.copyCode(copyButton));

    const teamHint = document.createElement('div');
    teamHint.className = 'lobby-team-hint';
    teamHint.textContent = '點對面的空位即可換隊 · 每隊最多 6 人';

    // §1 — two-column team slot grid (A blue / B red), populated per LobbyState.
    const slotGrid = document.createElement('div');
    slotGrid.className = 'lobby-slot-grid';

    // M2.7 §4 — map picker: host clicks a card to change it, non-host sees the
    // current selection highlighted (renderMapPicker() disables the cards).
    const mapLabel = document.createElement('div');
    mapLabel.className = 'lobby-map-label';
    mapLabel.textContent = '地圖';
    const mapPicker = buildMapPicker((map) => this.callbacks.onSetMap(map));

    const start = document.createElement('button');
    start.className = 'lobby-button lobby-button-primary';
    start.textContent = '開始比賽';
    start.disabled = true;
    start.addEventListener('click', () => this.callbacks.onStart());

    const hint = document.createElement('div');
    hint.className = 'lobby-hint';

    const leaveButton = document.createElement('button');
    leaveButton.className = 'lobby-button lobby-button-ghost';
    leaveButton.textContent = '離開';
    leaveButton.addEventListener('click', () => this.callbacks.onLeaveToMenu());

    card.append(title, codeLabel, codeDisplay, copyButton, teamHint, slotGrid, mapLabel, mapPicker, start, hint, leaveButton);
    screen.append(card);
    return { screen, codeDisplay, slotGrid, mapPicker, start, hint };
  }

  private buildGameOverScreen(): { screen: HTMLElement; scoreEl: HTMLElement } {
    const screen = document.createElement('div');
    screen.className = 'lobby-screen lobby-gameover';
    const card = document.createElement('div');
    card.className = 'lobby-glass-card';

    const title = document.createElement('h1');
    title.className = 'lobby-title';
    title.textContent = '比賽結束';

    const scoreEl = document.createElement('div');
    scoreEl.className = 'lobby-final-score';

    const rematchButton = document.createElement('button');
    rematchButton.className = 'lobby-button lobby-button-primary';
    rematchButton.textContent = '返回選單';
    rematchButton.addEventListener('click', () => this.callbacks.onLeaveToMenu());

    card.append(title, scoreEl, rematchButton);
    screen.append(card);
    return { screen, scoreEl };
  }

  private buildTransitionScreen(): HTMLElement {
    const screen = document.createElement('div');
    screen.className = 'lobby-screen lobby-transition';
    const card = document.createElement('div');
    card.className = 'lobby-glass-card lobby-transition-card';
    const title = document.createElement('div');
    title.className = 'lobby-transition-title';
    title.textContent = '進入練習場…';
    const sub = document.createElement('div');
    sub.className = 'lobby-transition-sub';
    sub.textContent = '單人沙盒・不計分';
    card.append(title, sub);
    screen.append(card);
    return screen;
  }

  // ---- public API -----------------------------------------------------------

  showMenu(): void {
    this.practiceActive = false;
    this.menu.reset();
    this.setActiveScreen(this.menu.element);
  }

  showError(message: string): void {
    this.menu.showError(message);
  }

  // Called once a room has been created/joined but before the first
  // LobbyState arrives, so the waiting screen never flashes empty.
  showWaitingPlaceholder(code: string): void {
    this.codeDisplayEl.textContent = code;
    this.setActiveScreen(this.waitingScreen);
  }

  // §5 — practice: skip the waiting room; hold a "進入練習場…" card over the
  // brief lobby autostart window until the sandbox reaches the serve phase.
  showPracticeTransition(): void {
    this.practiceActive = true;
    this.setActiveScreen(this.transitionScreen);
  }

  setLobbyState(state: LobbyState, ownSessionId: string): void {
    const previous = this.latestLobbyState;
    this.latestLobbyState = state;
    this.codeDisplayEl.textContent = state.code;

    this.renderSlots(state, ownSessionId, previous);

    const isHost = state.hostId === ownSessionId;
    renderMapPicker(this.mapPickerEl, state, isHost);
    this.startButton.style.display = isHost ? 'inline-block' : 'none';
    this.startButton.disabled = !state.canStart;
    this.waitingHintEl.textContent = isHost
      ? state.canStart
        ? '準備就緒 — 大家到齊就開始。'
        : '需要至少 2 名玩家，兩邊各一人。'
      : '等待房主開始比賽…';
  }

  // §1 — rebuild the A/B slot columns from the authoritative slot list. Cheap
  // (12 cards) and only runs on a LobbyState broadcast, not per frame.
  //
  // §9a fix — every card is a brand-new DOM node every call (innerHTML reset
  // below), so a per-card CSS *animation* (not a transition needing a "show"
  // class held across renders) always plays on insertion. computeChangedSlotKeys
  // scopes it to just the slots whose occupant actually changed vs. `previous`,
  // so a switch pops both the vacated and the newly-filled card, consistently,
  // every time, in both directions — not just the first switch after mount.
  private renderSlots(state: LobbyState, ownSessionId: string, previous: LobbyState | undefined): void {
    const changedKeys = computeChangedSlotKeys(previous, state);
    this.slotGridEl.innerHTML = '';
    this.slotGridEl.append(
      this.buildSlotColumn('A', state, ownSessionId, changedKeys),
      this.buildSlotColumn('B', state, ownSessionId, changedKeys),
    );
  }

  private buildSlotColumn(side: Side, state: LobbyState, ownSessionId: string, changedKeys: ReadonlySet<string>): HTMLElement {
    const col = document.createElement('div');
    col.className = `lobby-slot-col lobby-slot-col-${side}`;
    col.appendChild(buildTeamHeader(side, state, ownSessionId, this.callbacks.onSetTeamName));

    const slots = state.slots
      .filter((slot) => slot.side === side)
      .sort((a, b) => a.index - b.index);
    for (const slot of slots) col.appendChild(this.buildSlotCard(slot, state, ownSessionId, changedKeys));
    return col;
  }

  private buildSlotCard(
    slot: TeamSlot,
    state: LobbyState,
    ownSessionId: string,
    changedKeys: ReadonlySet<string>,
  ): HTMLElement {
    const card = document.createElement('div');
    const didChange = changedKeys.has(slotKey(slot.side, slot.index));

    if (slot.playerId === null) {
      card.className = `lobby-slot-card lobby-slot-empty${didChange ? ' lobby-slot-card-anim' : ''}`;
      card.textContent = '點擊加入';
      card.addEventListener('click', () => this.callbacks.onRequestSlot(slot.side, slot.index));
      return card;
    }

    const isSelf = slot.playerId === ownSessionId;
    card.className = `lobby-slot-card lobby-slot-filled${isSelf ? ' lobby-slot-self' : ''}${didChange ? ' lobby-slot-card-anim' : ''}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'lobby-slot-name';
    nameSpan.textContent = slot.name ?? '玩家';
    card.appendChild(nameSpan);

    const badges = document.createElement('span');
    badges.className = 'lobby-slot-badges';
    if (slot.playerId === state.hostId) badges.appendChild(makeBadge('房主', 'lobby-badge-host'));
    if (slot.playerId === state.captains[slot.side]) badges.appendChild(makeBadge('隊長', 'lobby-badge-captain'));
    if (isSelf) badges.appendChild(makeBadge('你', 'lobby-badge-you'));
    card.appendChild(badges);
    return card;
  }

  // Drives which screen is visible purely from the server-authoritative
  // phase: 'lobby' -> waiting room (or the practice transition card while a
  // sandbox is spinning up), 'gameover' -> handled by caller via showGameOver(),
  // everything else (serve/rally/deadball) hides the lobby overlay entirely so
  // the 3D scene + HUD show through.
  setPhaseVisibility(phase: MatchPhase): void {
    if (phase === 'lobby') {
      this.setActiveScreen(this.practiceActive ? this.transitionScreen : this.waitingScreen);
      return;
    }
    if (phase === 'gameover') return; // caller drives this via showGameOver()
    this.setActiveScreen(undefined);
  }

  showGameOver(score: ScoreState): void {
    this.gameoverScoreEl.textContent = `${score.A} — ${score.B}`;
    this.setActiveScreen(this.gameoverScreen);
  }

  private setActiveScreen(screen: HTMLElement | undefined): void {
    for (const candidate of [this.menu.element, this.waitingScreen, this.gameoverScreen, this.transitionScreen]) {
      candidate.style.display = candidate === screen ? 'flex' : 'none';
    }
    this.root.style.pointerEvents = screen ? 'auto' : 'none';
  }

  private async copyCode(button: HTMLButtonElement): Promise<void> {
    const code = this.latestLobbyState?.code ?? this.codeDisplayEl.textContent ?? '';
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = '已複製！';
    } catch {
      button.textContent = '請手動選取上方房碼';
    }
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  }
}

function makeBadge(text: string, className: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `lobby-badge ${className}`;
  badge.textContent = text;
  return badge;
}
