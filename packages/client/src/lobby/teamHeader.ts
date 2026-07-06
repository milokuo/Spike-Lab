import type { LobbyState, Side } from '@spike/shared';

// M2.7 §5 — client-side guard mirroring the server's 1..12 char rule (the
// server is still authoritative and re-validates/trims on receipt).
const TEAM_NAME_MAX_LEN = 12;

// Builds a team column header: the display name, plus (captain-only) a small
// edit affordance that swaps the header into an inline input. Enter or blur
// commits via onCommitName; CH.SET_TEAM_NAME carries only the name — the
// server infers which side from the sender.
export function buildTeamHeader(
  side: Side,
  state: LobbyState,
  ownSessionId: string,
  onCommitName: (name: string) => void,
): HTMLElement {
  const header = document.createElement('div');
  header.className = 'lobby-slot-header';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'lobby-team-name';
  nameSpan.textContent = state.teamNames[side];
  header.appendChild(nameSpan);

  if (state.captains[side] === ownSessionId) {
    const editButton = document.createElement('button');
    editButton.className = 'lobby-team-name-edit';
    editButton.textContent = '✎';
    editButton.title = '編輯隊名';
    editButton.addEventListener('click', () => beginTeamNameEdit(header, state.teamNames[side], onCommitName));
    header.appendChild(editButton);
  }

  return header;
}

function beginTeamNameEdit(header: HTMLElement, currentName: string, onCommitName: (name: string) => void): void {
  header.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'lobby-team-name-input';
  input.maxLength = TEAM_NAME_MAX_LEN;
  input.value = currentName;

  const commit = (): void => {
    const name = input.value.trim().slice(0, TEAM_NAME_MAX_LEN);
    if (name.length > 0 && name !== currentName) onCommitName(name);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  input.addEventListener('blur', commit, { once: true });

  header.appendChild(input);
  input.focus();
  input.select();
}
