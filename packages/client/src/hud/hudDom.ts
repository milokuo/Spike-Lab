// Small DOM builders shared by the HUD. Extracted from hud.ts to keep that
// file focused on HUD behaviour/state.
import type { ConnectionStatus } from '../net/connection';
import { PRACTICE_CHIP_LABEL, PRACTICE_LEAVE_LABEL } from './hudText';

export function createBarFill(className: string): HTMLElement {
  const fill = document.createElement('div');
  fill.className = `hud-bar-fill ${className}`;
  return fill;
}

export function track(fill: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hud-bar-track';
  el.appendChild(fill);
  return el;
}

// M2.9 §5 — practice-mode chip: a "練習模式" label + a 離開 button (wired to
// onLeave). Starts hidden; hud.setPracticeMode toggles display. pointer-events
// is enabled only on the chip (hudStyles) so the rest of the HUD stays
// click-through.
export function buildPracticeChip(onLeave: () => void): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'hud-practice-chip';
  chip.style.display = 'none';
  const label = document.createElement('span');
  label.className = 'hud-practice-label';
  label.textContent = PRACTICE_CHIP_LABEL;
  const leave = document.createElement('button');
  leave.className = 'hud-practice-leave';
  leave.textContent = PRACTICE_LEAVE_LABEL;
  leave.addEventListener('click', onLeave);
  chip.append(label, leave);
  return chip;
}

export function labeled(label: string, el: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hud-labeled';
  const labelEl = document.createElement('span');
  labelEl.className = 'hud-label';
  labelEl.textContent = label;
  wrap.append(labelEl, el);
  return wrap;
}

export interface ConnectionOverlayEls {
  overlay: HTMLElement;
  message: HTMLElement;
  retryButton: HTMLButtonElement;
}

// Drives the full-screen connection overlay's visibility/copy from a
// ConnectionStatus. Extracted out of Hud so that class doesn't own the
// message-string switch statement directly.
export function applyConnectionStatus(els: ConnectionOverlayEls, status: ConnectionStatus): void {
  switch (status) {
    case 'connecting':
      els.overlay.style.display = 'flex';
      els.message.textContent = 'Connecting to server...';
      els.retryButton.style.display = 'none';
      break;
    case 'connected':
      els.overlay.style.display = 'none';
      break;
    case 'disconnected':
      els.overlay.style.display = 'flex';
      els.message.textContent = 'Connection lost.';
      els.retryButton.style.display = 'inline-block';
      break;
    case 'error':
      els.overlay.style.display = 'flex';
      els.message.textContent = 'Could not connect to server.';
      els.retryButton.style.display = 'inline-block';
      break;
  }
}
