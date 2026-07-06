import type { LobbyState, MapId } from '@spike/shared';

// M2.7 §4 — the two selectable maps + their lobby-picker labels.
const MAP_OPTIONS: ReadonlyArray<{ id: MapId; label: string }> = [
  { id: 'indoor', label: '室內' },
  { id: 'outdoor', label: '室外' },
];

// Builds the (initially unselected) map picker; host clicks a card to change
// it. Non-host cards get disabled by renderMapPicker() below.
export function buildMapPicker(onSelect: (map: MapId) => void): HTMLElement {
  const picker = document.createElement('div');
  picker.className = 'lobby-map-picker';
  for (const option of MAP_OPTIONS) {
    const card = document.createElement('button');
    card.className = 'lobby-map-card';
    card.textContent = option.label;
    card.dataset.map = option.id;
    card.addEventListener('click', () => onSelect(option.id));
    picker.appendChild(card);
  }
  return picker;
}

// Host cards stay clickable; non-host cards just reflect the current pick
// (disabled + highlighted), per spec "非 host 顯示當前選擇".
export function renderMapPicker(picker: HTMLElement, state: LobbyState, isHost: boolean): void {
  for (const child of Array.from(picker.children)) {
    if (!(child instanceof HTMLButtonElement)) continue;
    const isSelected = child.dataset.map === state.map;
    child.classList.toggle('lobby-map-card-selected', isSelected);
    child.disabled = !isHost;
  }
}
