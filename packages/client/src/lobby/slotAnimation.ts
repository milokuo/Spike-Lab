import type { LobbyState, Side } from '@spike/shared';

// M2.7 §9a — slot-card "did this occupant change since the last broadcast"
// helper. Scopes the switch-animation to just the cards that actually moved
// (both the vacated and the newly-filled slot), so it fires every time a
// switch happens — not just once — consistently in both directions.

export function slotKey(side: Side, index: number): string {
  return `${side}-${index}`;
}

// A slot "changed" if its occupant differs from the previous broadcast
// (covers joins, leaves, AND switches). No `previous` (first mount) means
// nothing has switched yet, so nothing animates.
export function computeChangedSlotKeys(previous: LobbyState | undefined, state: LobbyState): ReadonlySet<string> {
  const changed = new Set<string>();
  if (!previous) return changed;
  const prevOccupants = new Map(previous.slots.map((slot) => [slotKey(slot.side, slot.index), slot.playerId]));
  for (const slot of state.slots) {
    const key = slotKey(slot.side, slot.index);
    if (prevOccupants.get(key) !== slot.playerId) changed.add(key);
  }
  return changed;
}
