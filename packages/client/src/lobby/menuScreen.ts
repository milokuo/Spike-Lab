import { DEFAULT_PLAYER_NAME } from '../config';
import { injectMenuStyles } from './menuStyles';
import { createVolleyballLogo } from './volleyballLogo';

// M2.9 §3/§5/§6 — the title menu: SPIKE LAB brand block, the two skewed
// parallelogram mode cards (練習模式 / 多人對戰), a shared "player nameplate"
// input row, and the multiplayer sub-panel (create / join-by-code) that slides
// in over the cards. Owns its own DOM + interaction; LobbyView treats it as one
// screen and forwards the three menu intents on to main.ts.
export interface MenuScreenCallbacks {
  // §5 — practice card: straight into a private single-player sandbox room.
  onPractice: (name: string) => void;
  // Multiplayer panel: host a new room / join a friend's room by code.
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
}

export class MenuScreen {
  readonly element: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly cardsView: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly codeInput: HTMLInputElement;
  private readonly errorEl: HTMLElement;

  constructor(initialName: string, private readonly callbacks: MenuScreenCallbacks) {
    injectMenuStyles();

    this.element = document.createElement('div');
    this.element.className = 'lobby-screen lobby-menu';

    const stage = document.createElement('div');
    stage.className = 'menu-stage';

    stage.appendChild(this.buildBrand());

    this.cardsView = this.buildCards();
    stage.appendChild(this.cardsView);

    const { row, input } = this.buildNamebar(initialName);
    this.nameInput = input;
    stage.appendChild(row);

    const { panel, codeInput, errorEl } = this.buildPanel();
    this.panel = panel;
    this.codeInput = codeInput;
    this.errorEl = errorEl;
    stage.appendChild(panel);

    this.element.appendChild(stage);
  }

  // ---- construction --------------------------------------------------------

  private buildBrand(): HTMLElement {
    const brand = document.createElement('div');
    brand.className = 'menu-brand';

    const text = document.createElement('div');
    text.className = 'menu-brand-text';
    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'SPIKE LAB';
    const subtitle = document.createElement('div');
    subtitle.className = 'menu-subtitle';
    subtitle.textContent = '妖球排球';
    text.append(title, subtitle);

    brand.append(createVolleyballLogo(), text);
    return brand;
  }

  private buildCards(): HTMLElement {
    const cards = document.createElement('div');
    cards.className = 'menu-cards';
    cards.append(
      this.buildCard('menu-card-practice', 'SOLO', '練習模式', '單人球場・自由發球與連擊・不計分', () =>
        this.callbacks.onPractice(this.nameOrDefault()),
      ),
      this.buildCard('menu-card-versus', 'VERSUS', '多人對戰', '開房間邀朋友，或輸入房碼加入', () =>
        this.openPanel(),
      ),
    );
    return cards;
  }

  private buildCard(variant: string, kicker: string, title: string, desc: string, onActivate: () => void): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `menu-card ${variant}`;
    card.innerHTML = `
      <div class="menu-card-kicker">${kicker}</div>
      <div class="menu-card-title">${title}</div>
      <div class="menu-card-desc">${desc}</div>
      <div class="menu-card-arrow">→</div>`;
    card.addEventListener('click', onActivate);
    return card;
  }

  private buildNamebar(initialName: string): { row: HTMLElement; input: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'menu-namebar';
    const label = document.createElement('span');
    label.className = 'menu-namebar-label';
    label.textContent = 'PLAYER';
    const input = document.createElement('input');
    input.className = 'menu-name-input';
    input.placeholder = 'Your name';
    input.maxLength = 24;
    input.value = initialName;
    row.append(label, input);
    return { row, input };
  }

  private buildPanel(): { panel: HTMLElement; codeInput: HTMLInputElement; errorEl: HTMLElement } {
    const panel = document.createElement('div');
    panel.className = 'menu-panel';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'menu-back';
    back.textContent = '← 返回';
    back.addEventListener('click', () => this.closePanel());

    const card = document.createElement('div');
    card.className = 'menu-panel-card';

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'menu-btn menu-btn-primary';
    createBtn.innerHTML = '<span>開新房間</span>';
    createBtn.addEventListener('click', () => this.callbacks.onCreate(this.nameOrDefault()));

    const divider = document.createElement('div');
    divider.className = 'menu-panel-divider';
    divider.textContent = '或輸入房碼加入朋友';

    const joinRow = document.createElement('div');
    joinRow.className = 'menu-join-row';
    const codeInput = document.createElement('input');
    codeInput.className = 'menu-code-input';
    codeInput.placeholder = '房碼';
    codeInput.maxLength = 16;
    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'menu-btn';
    joinBtn.innerHTML = '<span>加入</span>';
    const submitJoin = (): void => {
      const code = codeInput.value.trim();
      if (!code) {
        this.showError('請先輸入房碼。');
        return;
      }
      this.callbacks.onJoin(code, this.nameOrDefault());
    };
    joinBtn.addEventListener('click', submitJoin);
    codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitJoin();
    });
    joinRow.append(codeInput, joinBtn);

    const errorEl = document.createElement('div');
    errorEl.className = 'menu-error';

    card.append(createBtn, divider, joinRow, errorEl);
    panel.append(back, card);
    return { panel, codeInput, errorEl };
  }

  // ---- view state ----------------------------------------------------------

  private openPanel(): void {
    this.errorEl.textContent = '';
    this.cardsView.style.visibility = 'hidden';
    this.panel.classList.add('menu-panel-open');
  }

  private closePanel(): void {
    this.panel.classList.remove('menu-panel-open');
    this.cardsView.style.visibility = '';
    this.errorEl.textContent = '';
  }

  // Reset to the card view every time the menu is (re)shown, so a return to the
  // menu after an error never reopens straight onto a stale panel.
  reset(): void {
    this.closePanel();
  }

  showError(message: string): void {
    // Errors only originate from a create/join attempt, which happens from the
    // panel — surface them there (and make sure the panel is visible).
    if (!this.panel.classList.contains('menu-panel-open')) this.openPanel();
    this.errorEl.textContent = message;
  }

  private nameOrDefault(): string {
    return this.nameInput.value.trim() || DEFAULT_PLAYER_NAME;
  }
}
