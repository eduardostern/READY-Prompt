import { describe, expect, it } from 'vitest';
import { PALETTE, WIDTH } from '../src/c64/vic';
import { boot, sys } from './helpers';

/** The colour index at frame (x, y), x and y counted in the visible frame. */
function colorAt(frame: Uint32Array, x: number, y: number): number {
  return PALETTE.indexOf(frame[y * WIDTH + x]);
}
/** Frame row of raster line `line`, and column of sprite X coordinate `x` (PAL). */
const row = (line: number) => line - 16;
const col = (x: number) => x + 8;

const SPRITE0 = (x: number, y: number, color: number) => `
  LDA #13
  STA $07F8
  LDX #62
  LDA #$FF
fill: STA $0340,X
  DEX
  BPL fill
  LDA #${x}
  STA $D000
  LDA #${y}
  STA $D001
  LDA #${color}
  STA $D027
  LDA #1
  STA $D015
`;

describe('VIC-II', () => {
  it('steals the CPU 40 to 43 cycles on each of the 25 bad lines, none with the screen off', () => {
    const c = boot();
    const stolen = () => {
      const before = c.cycles - c.cpu.cycles;
      c.runFrame();
      return c.cycles - c.cpu.cycles - before;
    };
    c.runFrame();
    const on = stolen();
    expect(on).toBeGreaterThanOrEqual(25 * 40);
    expect(on).toBeLessThanOrEqual(25 * 43);
    c.poke(0xd011, 0x0b); // DEN off
    c.runFrame();
    expect(stolen()).toBe(0);
  });

  it('draws a sprite where it belongs: X 24 is the first column, 21 rows from the line after Y', () => {
    const c = boot();
    sys(c, `* = $C000\n${SPRITE0(24, 50, 2)}\n RTS`);
    const f = c.vic.frame;
    expect(colorAt(f, col(24), row(51))).toBe(2);
    expect(colorAt(f, col(24) + 23, row(51))).toBe(2);
    expect(colorAt(f, col(24) + 24, row(51))).toBe(6); // background, blue
    expect(colorAt(f, col(23), row(51))).toBe(14); // left border, light blue
    expect(colorAt(f, col(24), row(71))).toBe(2);
    expect(colorAt(f, col(24), row(72))).toBe(6);
  });

  it('sees sprites collide with each other and with text', () => {
    const c = boot();
    sys(c, `* = $C000\n${SPRITE0(24, 50, 2)}
      LDA #13
      STA $07F9
      LDA #30
      STA $D002
      LDA #60
      STA $D003
      LDA #3
      STA $D015
      RTS`);
    expect(c.peek(0xd01e) & 3).toBe(3);
    // The banner's text is under both sprites.
    expect(c.peek(0xd01f) & 1).toBe(1);
  });

  it('opens the bottom border when RSEL goes to 24 rows between lines 247 and 251', () => {
    const program = (open: boolean) => `
      * = $C000
      SEI
      LDA #$7F
      STA $DC0D
      LDA $DC0D
      LDA #<irq
      STA $0314
      LDA #>irq
      STA $0315
      LDA #249
      STA $D012
      LDA #$1B
      STA $D011
      LDA #$FF
      STA $D019
      LDA #1
      STA $D01A
      ${SPRITE0(100, 252, 2)}
      CLI
      RTS
irq:  LDA $D012
      CMP #249
      BNE top
      LDA $D011
      AND #${open ? '$F7' : '$FF'}
      STA $D011
      LDA #20
      STA $D012
      JMP done
top:  LDA $D011
      ORA #$08
      STA $D011
      LDA #249
      STA $D012
done: LDA #$FF
      STA $D019
      JMP $EA81
    `;
    const shut = boot();
    sys(shut, program(false), 10);
    expect(colorAt(shut.vic.frame, col(100), row(253))).toBe(14);
    const opened = boot();
    sys(opened, program(true), 10);
    expect(colorAt(opened.vic.frame, col(100), row(253))).toBe(2);
    expect(colorAt(opened.vic.frame, col(100), row(273))).toBe(2);
    expect(colorAt(opened.vic.frame, col(100), row(274))).toBe(0); // idle graphics from 3FFFh
  });

  it('draws multicolour bitmap pixels from the background, screen nybbles and colour RAM', () => {
    const c = boot();
    sys(c, `
      * = $C000
      SEI
      LDA #$3B
      STA $D011
      LDA #$18
      STA $D016
      STA $D018
      LDA #0
      STA $D021
      LDA #%00011011
      LDX #7
bm:   STA $2000,X
      DEX
      BPL bm
      LDA #$25
      STA $0400
      LDA #7
      STA $D800
loop: JMP loop
    `);
    const f = c.vic.frame;
    const px = [0, 1, 2, 3, 4, 5, 6, 7].map(i => colorAt(f, col(24) + i, row(51)));
    expect(px).toEqual([0, 0, 2, 2, 5, 5, 7, 7]);
  });

  it('shows the extended background colours by the top two bits of a character (ECM)', () => {
    const c = boot();
    sys(c, `
      * = $C000
      SEI
      LDA #$5B
      STA $D011
      LDA #11
      STA $D022
      LDA #$60 ; screen code 32 (space) with bits 6-5 = %11 -> background 3
      ORA #$80
      STA $0400
      LDA #13
      STA $D024
loop: JMP loop
    `);
    expect(colorAt(c.vic.frame, col(24), row(51))).toBe(13);
  });

  it('doubles an expanded sprite to 48 pixels by 42 lines', () => {
    const c = boot();
    sys(c, `* = $C000\n${SPRITE0(100, 100, 2)}
      LDA #1
      STA $D017
      STA $D01D
      RTS`);
    const f = c.vic.frame;
    expect(colorAt(f, col(100) + 47, row(101))).toBe(2);
    expect(colorAt(f, col(100) + 48, row(101))).not.toBe(2);
    expect(colorAt(f, col(100), row(142))).toBe(2);
    expect(colorAt(f, col(100), row(143))).not.toBe(2);
  });

  it('puts a sprite behind the text when its priority bit is set', () => {
    const c = boot();
    // The banner's first star is at column 4 of row 1 (line 59, X 56).
    sys(c, `* = $C000\n${SPRITE0(56, 58, 2)}
      LDA #1
      STA $D01B
      RTS`);
    const f = c.vic.frame;
    const cells = Array.from({ length: 8 }, (_, i) => colorAt(f, col(56) + i, row(61)));
    expect(cells).toContain(14); // the star's light blue shows through
    expect(cells).toContain(2);
  });
});
