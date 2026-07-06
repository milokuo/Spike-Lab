// M2.6 §2 — serve rotation engine unit tests. Covers the four required cases
// (consecutive same-server, side-out advance, first-possession no-advance,
// leaver fix) plus the 1-player team invariant and the spec's worked example.
import { describe, test, expect } from 'vitest';
import {
  initRotation,
  currentServerId,
  onPoint,
  removePlayer,
} from '../src/rotation/serveRotation';

describe('serveRotation', () => {
  test('match start: side A rotationIdx=0 serves first', () => {
    // Arrange
    const rot = initRotation(['a0', 'a1'], ['b0', 'b1']);
    // Assert
    expect(rot.serving).toBe('A');
    expect(currentServerId(rot)).toBe('a0');
  });

  test('serving team scores again -> same server (no rotation)', () => {
    // Arrange
    let rot = initRotation(['a0', 'a1'], ['b0', 'b1']);
    // Act — A serves and scores twice consecutively
    rot = onPoint(rot, 'A');
    rot = onPoint(rot, 'A');
    // Assert
    expect(rot.serving).toBe('A');
    expect(currentServerId(rot)).toBe('a0');
  });

  test('first possession of the set does NOT advance (serve from idx 0)', () => {
    // Arrange — A serving; B has never held serve this set
    let rot = initRotation(['a0', 'a1'], ['b0', 'b1']);
    // Act — B side-outs for the first time
    rot = onPoint(rot, 'B');
    // Assert — B serves from idx 0, not idx 1
    expect(rot.serving).toBe('B');
    expect(currentServerId(rot)).toBe('b0');
  });

  test('side-out on a team that already held serve advances the idx THEN serves', () => {
    // Arrange
    let rot = initRotation(['a0', 'a1'], ['b0', 'b1']);
    rot = onPoint(rot, 'B'); // B first possession -> b0 (no advance)
    rot = onPoint(rot, 'A'); // A already held (served first) -> advance to a1
    // Assert
    expect(rot.serving).toBe('A');
    expect(currentServerId(rot)).toBe('a1');
  });

  test('spec worked example: A×2 (same), B side-out (b0), B scores (same), A side-out (a1)', () => {
    // Arrange
    let rot = initRotation(['a0', 'a1'], ['b0', 'b1']);
    // Act + Assert step by step
    rot = onPoint(rot, 'A'); // A scores (same server)
    rot = onPoint(rot, 'A'); // A scores again (same server)
    expect(currentServerId(rot)).toBe('a0');
    rot = onPoint(rot, 'B'); // B side-out, first possession -> b0
    expect(currentServerId(rot)).toBe('b0');
    rot = onPoint(rot, 'B'); // B scores (same server)
    expect(currentServerId(rot)).toBe('b0');
    rot = onPoint(rot, 'A'); // A side-out, already held -> advance to a1
    expect(currentServerId(rot)).toBe('a1');
  });

  test('advance wraps modulo team size', () => {
    // Arrange — 2-player A team, force two A side-outs after its first serve
    let rot = initRotation(['a0', 'a1'], ['b0']);
    rot = onPoint(rot, 'B'); // B first possession -> b0
    rot = onPoint(rot, 'A'); // A already held -> a1
    expect(currentServerId(rot)).toBe('a1');
    rot = onPoint(rot, 'B'); // B holds again -> advance b (size 1) stays b0
    rot = onPoint(rot, 'A'); // A already held -> (1+1)%2 -> a0
    expect(currentServerId(rot)).toBe('a0');
  });

  test('1-player team always serves that one player', () => {
    // Arrange
    let rot = initRotation(['solo'], ['b0', 'b1', 'b2']);
    // Act — several A possessions
    rot = onPoint(rot, 'B'); // side-out to B (b0)
    rot = onPoint(rot, 'A'); // side-out back to A
    // Assert — A has only one player; idx wraps to the same id
    expect(currentServerId(rot)).toBe('solo');
    rot = onPoint(rot, 'A'); // consecutive A score
    expect(currentServerId(rot)).toBe('solo');
  });

  test('leaver fix: removing the current server points at the next player', () => {
    // Arrange — A serving at a1
    let rot = initRotation(['a0', 'a1', 'a2'], ['b0']);
    rot = onPoint(rot, 'B'); // b0
    rot = onPoint(rot, 'A'); // A advances to a1
    expect(currentServerId(rot)).toBe('a1');
    // Act — a1 (the current server) leaves
    rot = removePlayer(rot, 'a1');
    // Assert — order shrinks; idx wraps within the smaller order
    expect(rot.a.order).toEqual(['a0', 'a2']);
    expect(currentServerId(rot)).toBe('a2'); // idx 1 % 2 = 1 -> a2
  });

  test('leaver fix: removing a non-current player keeps the current server stable', () => {
    // Arrange — A serving at a2
    let rot = initRotation(['a0', 'a1', 'a2'], ['b0']);
    rot = onPoint(rot, 'B');
    rot = onPoint(rot, 'A'); // -> a1
    rot = onPoint(rot, 'B');
    rot = onPoint(rot, 'A'); // -> a2
    expect(currentServerId(rot)).toBe('a2');
    // Act — a0 (not the current server) leaves
    rot = removePlayer(rot, 'a0');
    // Assert — a2 is still the current server (idx shifted to keep it)
    expect(rot.a.order).toEqual(['a1', 'a2']);
    expect(currentServerId(rot)).toBe('a2');
  });

  test('leaver fix: emptying a team yields empty current server id', () => {
    // Arrange
    let rot = initRotation(['solo'], ['b0']);
    // Act
    rot = removePlayer(rot, 'solo');
    // Assert — serving side stays A (now empty) -> current server id is ''
    expect(rot.a.order).toEqual([]);
    expect(rot.serving).toBe('A');
    expect(currentServerId(rot)).toBe('');
  });
});
