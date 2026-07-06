import type { TouchMode } from '@spike/shared';

// M2.3 §4 — bottom-right 3×3 skill/mode grid. Replaces the old horizontal mode
// badge row. Layout (middle row carries the extra 發球 cell on the left):
//   [U] [I] [O]
//   [發球] [J] [K] [L]
//   [M] [,] [.]
// J/K/L are the live touch modes (active one highlighted in the shared blue/
// green/red). U/I/O/M/,/. are empty skill slots (M3 content). 發球 lights up
// during the serve phase when it's YOUR serve.

const MODE_CELLS: ReadonlyArray<{ mode: TouchMode; key: string }> = [
  { mode: 'dig', key: 'J' },
  { mode: 'set', key: 'K' },
  { mode: 'spike', key: 'L' },
];

const SKILL_KEYS = ['U', 'I', 'O', 'M', ',', '.'] as const;

export class SkillGrid {
  readonly root: HTMLElement;
  private readonly modeCells = new Map<TouchMode, HTMLElement>();
  private readonly serveCell: HTMLElement;
  // M2.7 §8 — the 9 wheel/Q-E selectable cells in linear sequence order
  // [U,I,O,J,K,L,M,',','.'] (the 發球 cell is NOT selectable). Index into this
  // for the "selected cell" highlight, kept separate from the active mode.
  private readonly selectableCells: HTMLElement[];
  private selectedIndex = -1;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'hud-skill-grid';
    this.serveCell = this.buildServeCell();

    // Build the selectable cells first so we can both place them in CSS-grid
    // order AND keep them in linear-sequence order for setSelection.
    const u = this.buildSkillCell(SKILL_KEYS[0]);
    const i = this.buildSkillCell(SKILL_KEYS[1]);
    const o = this.buildSkillCell(SKILL_KEYS[2]);
    const j = this.buildModeCell('dig', 'J');
    const k = this.buildModeCell('set', 'K');
    const l = this.buildModeCell('spike', 'L');
    const m = this.buildSkillCell(SKILL_KEYS[3]);
    const comma = this.buildSkillCell(SKILL_KEYS[4]);
    const dot = this.buildSkillCell(SKILL_KEYS[5]);
    // Sequence order = [U,I,O,J,K,L,M,',','.'] (matches keyboard SKILL_SEQUENCE).
    this.selectableCells = [u, i, o, j, k, l, m, comma, dot];

    // Cell order matches CSS-grid placement (see hud styles): row1 spacer + UIO,
    // row2 發球 + JKL, row3 spacer + M ',' '.'.
    this.root.append(spacer(), u, i, o, this.serveCell, j, k, l, spacer(), m, comma, dot);
  }

  setMode(mode: TouchMode): void {
    for (const [cellMode, el] of this.modeCells) {
      el.classList.toggle('hud-grid-mode-active', cellMode === mode);
    }
  }

  // M2.7 §8 — highlight the wheel/Q-E selected cell (distinct from active mode).
  setSelection(index: number): void {
    if (index === this.selectedIndex) return;
    if (this.selectedIndex >= 0) {
      this.selectableCells[this.selectedIndex]?.classList.remove('hud-grid-selected');
    }
    this.selectedIndex = index;
    this.selectableCells[index]?.classList.add('hud-grid-selected');
  }

  // §4 — 發球 cell bright while it's this client's turn to serve, dim otherwise.
  setServeActive(active: boolean): void {
    this.serveCell.classList.toggle('hud-grid-serve-active', active);
  }

  private buildModeCell(mode: TouchMode, key: string): HTMLElement {
    const cell = document.createElement('div');
    cell.className = `hud-grid-cell hud-grid-mode hud-grid-mode-${mode}`;
    cell.innerHTML = `<span class="hud-grid-key">${key}</span>`;
    this.modeCells.set(mode, cell);
    return cell;
  }

  private buildServeCell(): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'hud-grid-cell hud-grid-serve';
    cell.innerHTML = `<span class="hud-grid-label">發</span>`;
    return cell;
  }

  private buildSkillCell(key: string): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'hud-grid-cell hud-grid-skill';
    cell.innerHTML = `<span class="hud-grid-key">${key}</span><span class="hud-grid-lock">－</span>`;
    return cell;
  }
}

function spacer(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hud-grid-spacer';
  return el;
}

// Injected once by hud.ts alongside the rest of the HUD styles.
export const SKILL_GRID_STYLES = `
  .hud-skill-grid { position: fixed; bottom: 16px; right: 16px; display: grid; grid-template-columns: repeat(4, 46px); grid-auto-rows: 46px; gap: 6px; pointer-events: none; }
  .hud-grid-spacer { }
  .hud-grid-cell { display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 8px; background: rgba(0,0,0,0.35); border: 2px solid rgba(255,255,255,0.14); }
  .hud-grid-key { font-size: 15px; font-weight: 800; color: rgba(255,255,255,0.85); text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
  .hud-grid-skill { border-style: dashed; opacity: 0.5; }
  .hud-grid-skill .hud-grid-key { color: rgba(255,255,255,0.55); font-size: 13px; }
  .hud-grid-lock { font-size: 12px; color: rgba(255,255,255,0.4); }
  .hud-grid-mode { opacity: 0.55; transition: opacity 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease; }
  .hud-grid-mode-active { opacity: 1; transform: translateY(-2px) scale(1.05); }
  .hud-grid-mode-dig.hud-grid-mode-active { border-color: #3fa7ff; box-shadow: 0 0 12px rgba(63,167,255,0.6); }
  .hud-grid-mode-set.hud-grid-mode-active { border-color: #4dd67c; box-shadow: 0 0 12px rgba(77,214,124,0.6); }
  .hud-grid-mode-spike.hud-grid-mode-active { border-color: #ff5a5a; box-shadow: 0 0 12px rgba(255,90,90,0.6); }
  .hud-grid-selected { opacity: 1; outline: 2px solid #ffffff; outline-offset: 2px; box-shadow: 0 0 8px rgba(255,255,255,0.75); }
  .hud-grid-skill.hud-grid-selected .hud-grid-key { color: rgba(255,255,255,0.95); }
  .hud-grid-serve { opacity: 0.45; }
  .hud-grid-serve .hud-grid-label { font-size: 18px; font-weight: 800; color: #fff; }
  .hud-grid-serve-active { opacity: 1; border-color: #ffe14d; box-shadow: 0 0 14px rgba(255,225,77,0.7); }
  .hud-grid-serve-active .hud-grid-label { color: #ffe14d; }
`;
