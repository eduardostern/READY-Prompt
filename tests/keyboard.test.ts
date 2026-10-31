import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyInput, KEYS, keysFor, Matrix, SHIFT } from '../src/c64/keyboard';

describe('keyboard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads the matrix both ways', () => {
    const m = new Matrix();
    m.set([KEYS.A]); // column 1, row 2
    expect(m.rows(0xfd)).toBe(0x04);
    expect(m.rows(0xfe)).toBe(0);
    expect(m.columns(0xfb)).toBe(0x02);
  });

  it('types symbols the C64 way', () => {
    expect(keysFor('"')).toEqual([SHIFT, KEYS['2']]);
    expect(keysFor('+')).toEqual([KEYS['+']]);
    expect(keysFor('[')).toEqual([SHIFT, KEYS[':']]);
  });

  it('drops PC Shift while a symbol of its own is held', () => {
    let held: number[] = [];
    const k = new KeyInput(h => { held = h; });
    k.keyDown('ShiftLeft', 'Shift');
    k.keyDown('Equal', '+'); // Shift+= on a PC is the C64's own + key
    expect(held).toEqual([KEYS['+']]);
  });

  it('presses a key again when it comes twice within its minimum hold (HELLO)', () => {
    const states: number[][] = [];
    const k = new KeyInput(h => { states.push(h); });
    k.keyDown('KeyL', 'l'); k.keyUp('KeyL');
    vi.advanceTimersByTime(20);
    k.keyDown('KeyL', 'l'); k.keyUp('KeyL');
    vi.advanceTimersByTime(500);
    const presses = states.filter((s, i) => s.includes(KEYS.L) && !states[i - 1]?.includes(KEYS.L)).length;
    expect(presses).toBe(2);
    expect(states.at(-1)).toEqual([]);
  });
});
