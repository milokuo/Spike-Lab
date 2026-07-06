import type { ScoreState, Side, TeamNames } from '@spike/shared';

// Top-center scoreboard panel: dark glass card with per-team accent bars, big
// tabular-nums scores, a serving-side dot, and a small phase label under the
// divider. Extracted from hud.ts (mirrors skillGrid.ts / serveArc.ts: a small
// class + its own exported *_STYLES string plugged into hudStyles.ts).

// §5 — win-by-2 deuce zone: both teams at/above this tints the scores amber.
const DEUCE_SCORE_THRESHOLD = 14;

export class Scoreboard {
  readonly root: HTMLElement;
  private readonly nameAEl: HTMLElement;
  private readonly nameBEl: HTMLElement;
  private readonly scoreAEl: HTMLElement;
  private readonly scoreBEl: HTMLElement;
  private readonly serveDotAEl: HTMLElement;
  private readonly serveDotBEl: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private lastScore: ScoreState = { A: 0, B: 0 };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'hud-scoreboard';

    this.nameAEl = el('div', 'hud-scoreboard-name');
    this.nameBEl = el('div', 'hud-scoreboard-name');
    this.scoreAEl = el('span', 'hud-scoreboard-score');
    this.scoreBEl = el('span', 'hud-scoreboard-score');
    this.serveDotAEl = el('span', 'hud-scoreboard-serve-dot');
    this.serveDotBEl = el('span', 'hud-scoreboard-serve-dot');
    this.phaseEl = el('div', 'hud-scoreboard-phase');

    // Side A: score sits left of its serve dot so the dot lands next to the
    // center divider (the "inner" edge); side B mirrors this.
    const rowA = el('div', 'hud-scoreboard-score-row');
    rowA.append(this.scoreAEl, this.serveDotAEl);
    const sideA = el('div', 'hud-scoreboard-side');
    sideA.append(this.nameAEl, rowA);

    const rowB = el('div', 'hud-scoreboard-score-row');
    rowB.append(this.serveDotBEl, this.scoreBEl);
    const sideB = el('div', 'hud-scoreboard-side');
    sideB.append(rowB, this.nameBEl);

    const center = el('div', 'hud-scoreboard-center');
    const divider = el('div', 'hud-scoreboard-divider');
    divider.textContent = ':';
    center.append(divider, this.phaseEl);

    const accentA = el('div', 'hud-scoreboard-accent hud-scoreboard-accent-a');
    const accentB = el('div', 'hud-scoreboard-accent hud-scoreboard-accent-b');

    this.root.append(accentA, sideA, center, sideB, accentB);
    this.setTeamNames({ A: 'A 隊', B: 'B 隊' });
    this.setScore({ A: 0, B: 0 });
    this.setServingSide(null);
  }

  setTeamNames(names: TeamNames): void {
    this.nameAEl.textContent = names.A;
    this.nameBEl.textContent = names.B;
  }

  // Pops the digit that actually changed (scale-bounce) rather than both, and
  // tints both numerals amber once it's a 14-14+ deuce situation.
  setScore(score: ScoreState): void {
    this.applyScore(this.scoreAEl, this.lastScore.A, score.A);
    this.applyScore(this.scoreBEl, this.lastScore.B, score.B);
    const isDeuceZone = score.A >= DEUCE_SCORE_THRESHOLD && score.B >= DEUCE_SCORE_THRESHOLD;
    this.scoreAEl.classList.toggle('hud-scoreboard-score-hot', isDeuceZone);
    this.scoreBEl.classList.toggle('hud-scoreboard-score-hot', isDeuceZone);
    this.lastScore = score;
  }

  private applyScore(scoreEl: HTMLElement, prev: number, next: number): void {
    scoreEl.textContent = String(next);
    if (prev === next) return;
    scoreEl.classList.remove('hud-scoreboard-score-pop');
    void scoreEl.offsetWidth; // restart the animation on repeated same-value pops
    scoreEl.classList.add('hud-scoreboard-score-pop');
  }

  setPhaseText(text: string): void {
    this.phaseEl.textContent = text;
  }

  // §5 — pulsing dot beside the serving team's score; null hides both (deadball
  // / gameover / lobby, where "who serves next" isn't meaningful yet).
  setServingSide(side: Side | null): void {
    this.serveDotAEl.classList.toggle('hud-scoreboard-serve-dot-active', side === 'A');
    this.serveDotBEl.classList.toggle('hud-scoreboard-serve-dot-active', side === 'B');
  }
}

function el(tag: 'div' | 'span', className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

// Injected once by hud.ts alongside the rest of the HUD styles. Compact glass
// panel: width scales with viewport (clamped) so it stays roughly the "<15%
// viewport width" target across 1366x768 through 1080p+ without ever letting a
// 12-char Chinese team name blow out the layout (ellipsis handles overflow).
export const SCOREBOARD_STYLES = `
  .hud-scoreboard { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); display: flex; align-items: stretch; width: clamp(230px, 15vw, 300px); background: rgba(10,14,20,0.55); backdrop-filter: blur(10px) saturate(150%); -webkit-backdrop-filter: blur(10px) saturate(150%); border: 1px solid rgba(255,255,255,0.14); border-radius: 14px; box-shadow: 0 8px 22px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.07); overflow: hidden; pointer-events: none; color: #fff; }
  .hud-scoreboard-accent { flex: 0 0 4px; }
  .hud-scoreboard-accent-a { background: linear-gradient(180deg, #4a9eff, #2c6fd6); }
  .hud-scoreboard-accent-b { background: linear-gradient(180deg, #ff5a5a, #d63f3f); }
  .hud-scoreboard-side { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 6px 6px; }
  .hud-scoreboard-name { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; color: rgba(255,255,255,0.72); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
  .hud-scoreboard-score-row { display: flex; align-items: center; gap: 5px; }
  .hud-scoreboard-score { font-size: 30px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; text-shadow: 0 2px 6px rgba(0,0,0,0.55); transform-origin: center; }
  .hud-scoreboard-score-hot { color: #ffbf47; }
  .hud-scoreboard-score-pop { animation: hud-scoreboard-score-pop 260ms ease-out; }
  @keyframes hud-scoreboard-score-pop { 0% { transform: scale(1); } 35% { transform: scale(1.35); } 100% { transform: scale(1); } }
  .hud-scoreboard-center { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 0 4px; }
  .hud-scoreboard-divider { font-size: 20px; font-weight: 700; color: rgba(255,255,255,0.45); line-height: 1; }
  .hud-scoreboard-phase { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: rgba(255,255,255,0.55); text-transform: uppercase; white-space: nowrap; min-height: 11px; }
  .hud-scoreboard-serve-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.16); flex: 0 0 auto; transition: background 0.15s ease; }
  .hud-scoreboard-serve-dot-active { background: #ffe14d; box-shadow: 0 0 6px rgba(255,225,77,0.9); animation: hud-scoreboard-serve-pulse 1.1s ease-in-out infinite; }
  @keyframes hud-scoreboard-serve-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.35); } }
`;
