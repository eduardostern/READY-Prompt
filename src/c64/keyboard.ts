/**
 * The C64 keyboard: 64 keys in an 8 × 8 matrix. CIA1 port A drives the
 * columns (a 0 selects one), port B reads the rows (a pressed key reads 0);
 * the KERNAL scans that way, some games the other way round, and both
 * work. RESTORE is not in the matrix: it pulls the NMI line.
 *
 *         PB0     PB1     PB2    PB3   PB4     PB5  PB6  PB7
 *   PA0   DEL     RETURN  CRSR→  F7    F1      F3   F5   CRSR↓
 *   PA1   3       W       A      4     Z       S    E    LSHIFT
 *   PA2   5       R       D      6     C       F    T    X
 *   PA3   7       Y       G      8     B       H    U    V
 *   PA4   9       I       J      0     M       K    O    N
 *   PA5   +       P       L      -     .       :    @    ,
 *   PA6   £       *       ;      HOME  RSHIFT  =    ↑    /
 *   PA7   1       ←       CTRL   2     SPACE   C=   Q    STOP
 *
 * The PC keyboard is mapped by character, the way you would type on a C64:
 * `"` is SHIFT + 2, `+ * @ : = ;` are keys of their own (PC Shift is let
 * go while they are held), `[` `]` are SHIFT + `:` `;`.
 */

/** A key: column × 8 + row. */
export type Key = number;

const COLUMNS = [
  ['DEL', 'RETURN', 'RIGHT', 'F7', 'F1', 'F3', 'F5', 'DOWN'],
  ['3', 'W', 'A', '4', 'Z', 'S', 'E', 'LSHIFT'],
  ['5', 'R', 'D', '6', 'C', 'F', 'T', 'X'],
  ['7', 'Y', 'G', '8', 'B', 'H', 'U', 'V'],
  ['9', 'I', 'J', '0', 'M', 'K', 'O', 'N'],
  ['+', 'P', 'L', '-', '.', ':', '@', ','],
  ['£', '*', ';', 'HOME', 'RSHIFT', '=', '↑', '/'],
  ['1', '←', 'CTRL', '2', 'SPACE', 'C=', 'Q', 'STOP'],
];

export const KEYS: Record<string, Key> = {};
COLUMNS.forEach((col, c) => col.forEach((name, r) => { KEYS[name] = c * 8 + r; }));
export const SHIFT = KEYS.LSHIFT;

/** Characters typed with SHIFT on the C64. */
const SHIFTED: Record<string, string> = {
  '!': '1', '"': '2', '#': '3', '$': '4', '%': '5', '&': '6', "'": '7', '(': '8', ')': '9',
  '<': ',', '>': '.', '?': '/', '[': ':', ']': ';',
};
/** Characters that are a key of their own. */
const PLAIN: Record<string, string> = {
  '+': '+', '-': '-', '£': '£', '@': '@', '*': '*', '^': '↑', '=': '=', ':': ':', ';': ';',
  ',': ',', '.': '.', '/': '/', '_': '←', '\\': '£', ' ': 'SPACE',
};

/** The keys that type `ch` (shift-free letters are upper case on the C64). */
export function keysFor(ch: string): Key[] | null {
  if (ch === '\n' || ch === '\r') return [KEYS.RETURN];
  const up = ch.toUpperCase();
  if (/^[A-Z0-9]$/.test(up)) return [KEYS[up]];
  if (SHIFTED[ch]) return [SHIFT, KEYS[SHIFTED[ch]]];
  if (PLAIN[ch]) return [KEYS[PLAIN[ch]]];
  return null;
}

/** PC keys that are a C64 key (or combination) whatever character they type. */
const SPECIAL: Record<string, string[]> = {
  Backspace: ['DEL'], Insert: ['LSHIFT', 'DEL'], Delete: ['DEL'],
  Enter: ['RETURN'], NumpadEnter: ['RETURN'], Space: ['SPACE'],
  ArrowRight: ['RIGHT'], ArrowLeft: ['LSHIFT', 'RIGHT'], ArrowDown: ['DOWN'], ArrowUp: ['LSHIFT', 'DOWN'],
  Home: ['HOME'], End: ['LSHIFT', 'HOME'], Escape: ['STOP'],
  F1: ['F1'], F2: ['LSHIFT', 'F1'], F3: ['F3'], F4: ['LSHIFT', 'F3'],
  F5: ['F5'], F6: ['LSHIFT', 'F5'], F7: ['F7'], F8: ['LSHIFT', 'F7'],
  ShiftLeft: ['LSHIFT'], ShiftRight: ['RSHIFT'],
  ControlLeft: ['CTRL'], ControlRight: ['CTRL'], Tab: ['CTRL'],
  AltLeft: ['C='], AltRight: ['C='],
};

/** The PC key for RESTORE (it is wired to NMI, not the matrix). */
export const RESTORE_CODE = 'PageUp';

/** Shortest time a PC key stays down on the C64, in ms (the KERNAL scans every 1/60 s). */
const MIN_HOLD = 60;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The pressed keys, as CIA1 reads them. */
export class Matrix {
  /** For each column, the rows pressed (1 = down). */
  readonly cols = new Uint8Array(8);

  set(keys: Iterable<Key>): void {
    this.cols.fill(0);
    for (const k of keys) this.cols[k >> 3] |= 1 << (k & 7);
  }

  /** Port B: rows that read low with the columns `pa` drives (0 = selected). */
  rows(pa: number): number {
    let v = 0;
    for (let c = 0; c < 8; c++) if (!(pa & (1 << c))) v |= this.cols[c];
    return v;
  }

  /** Port A read back: columns that read low with the rows `pb` drives. */
  columns(pb: number): number {
    const sel = ~pb & 0xff;
    let v = 0;
    for (let c = 0; c < 8; c++) if (this.cols[c] & sel) v |= 1 << c;
    return v;
  }
}

type Entry = { keys: Key[]; own: boolean; at: number; timer?: ReturnType<typeof setTimeout> };

/** Time a key stays up between two presses of it, so the KERNAL sees both (ms). */
const REPRESS_GAP = 50;

/**
 * PC keys to the matrix. Each PC key down holds the C64 keys it stands for
 * until it comes up. While a key with its own shift state is held (a
 * symbol), PC Shift is dropped and the symbol's own SHIFT used.
 */
export class KeyInput {
  private down = new Map<string, Entry>();
  /** Keys pressed again while still held: they go down after a gap. */
  private again = new Map<string, { up: boolean }>();
  /** Keys pressed from elsewhere (the on-screen keyboard). */
  extra: Key[] = [];
  onRestore?: (down: boolean) => void;

  constructor(private readonly sink: (keys: Key[]) => void) {}

  /** Returns false for keys the C64 has no use for (they stay the browser's). */
  keyDown(code: string, key: string): boolean {
    if (code === RESTORE_CODE) { this.onRestore?.(true); return true; }
    if (this.again.has(code)) return true;
    const held = this.down.get(code);
    if (held) {
      if (!held.timer) return true; // auto-repeat: the KERNAL repeats by itself
      // Let go of it (it was only held for its minimum time), then press again.
      if (!this.entryFor(code, key)) return false;
      clearTimeout(held.timer);
      this.down.delete(code);
      this.update();
      const pending = { up: false };
      this.again.set(code, pending);
      setTimeout(() => {
        this.again.delete(code);
        this.keyDown(code, key);
        if (pending.up) this.keyUp(code);
      }, REPRESS_GAP);
      return true;
    }
    const entry = this.entryFor(code, key);
    if (!entry) return false;
    this.down.set(code, entry);
    this.update();
    return true;
  }

  private entryFor(code: string, key: string): Entry | undefined {
    const at = now();
    const special = SPECIAL[code];
    if (special) return { keys: special.map(n => KEYS[n]), own: false, at };
    if (key.length !== 1) return undefined;
    const up = key.toUpperCase();
    if (/^[A-Z0-9]$/.test(up)) return { keys: [KEYS[up]], own: false, at };
    const keys = keysFor(key);
    return keys ? { keys, own: true, at } : undefined;
  }

  /**
   * The KERNAL scans the keyboard 60 times a second, so a key let go within
   * a scan of its press could be missed: it is held at least MIN_HOLD ms.
   */
  keyUp(code: string): void {
    if (code === RESTORE_CODE) { this.onRestore?.(false); return; }
    const pending = this.again.get(code);
    if (pending) { pending.up = true; return; }
    const e = this.down.get(code);
    if (!e || e.timer) return;
    const left = MIN_HOLD - (now() - e.at);
    if (left > 0) {
      e.timer = setTimeout(() => { if (this.down.get(code) === e) { this.down.delete(code); this.update(); } }, left);
      return;
    }
    this.down.delete(code);
    this.update();
  }

  releaseAll(): void {
    for (const e of this.down.values()) clearTimeout(e.timer);
    this.down.clear();
    this.again.clear();
    this.update();
  }

  update(): void {
    const own = [...this.down.values()].some(e => e.own);
    const keys: Key[] = [...this.extra];
    for (const [code, e] of this.down) {
      if (own && (code === 'ShiftLeft' || code === 'ShiftRight')) continue;
      keys.push(...e.keys);
    }
    this.sink(keys);
  }
}
