/**
 * VIC-II: the 6569 (PAL, 63 cycles × 312 lines) and the 6567R8 (NTSC,
 * 65 × 263), run one cycle at a time by the machine.
 *
 * Each cycle does what Christian Bauer's "The MOS 6567/6569 video
 * controller" describes for it: the sprite pointer and data fetches
 * (p/s), the 40 character fetches of a bad line (c), the graphics fetches
 * (g), BA for the CPU, and then the 8 pixels the beam draws in that
 * cycle, with the registers as they are at that moment: border flip-flops
 * compared pixel by pixel, the graphics shifter loaded at XSCROLL, the
 * sprites' shifters started at their X.
 */

/** Colodore (Pepto, 2017), as 0xAABBGGRR for a little-endian ImageData. */
const RGB = [
  0x000000, 0xffffff, 0x813338, 0x75cec8, 0x8e3c97, 0x56ac4d, 0x2e2c9b, 0xedf171,
  0x8e5029, 0x553800, 0xc46c71, 0x4a4a4a, 0x7b7b7b, 0xa9ff9f, 0x706deb, 0xb2b2b2,
];
export const PALETTE = Uint32Array.from(RGB, c =>
  (0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)) >>> 0);

export interface VicTiming {
  cyclesPerLine: number;
  lines: number;
  /** First raster line drawn into the frame. */
  firstLine: number;
  /** Lines in the frame. */
  height: number;
  /** The cycle each sprite's pointer is fetched in (sprite 0..7). */
  spriteCycle: number[];
}

export const PAL: VicTiming = {
  cyclesPerLine: 63, lines: 312, firstLine: 16, height: 272,
  spriteCycle: [58, 60, 62, 1, 3, 5, 7, 9],
};
export const NTSC: VicTiming = {
  cyclesPerLine: 65, lines: 263, firstLine: 27, height: 235,
  spriteCycle: [60, 62, 64, 1, 3, 5, 7, 9],
};

/** The frame: 48 cycles of 8 pixels, cycles 12..59 (X = -8..375). */
export const WIDTH = 384;
const FIRST_CYCLE = 12;
const LAST_CYCLE = 59;

/** How the VIC reads memory: 14-bit address inside its bank → byte (12 bits for c). */
export type VicRead = (addr: number) => number;

class Sprite {
  x = 0; y = 0; color = 0;
  dma = false; display = false;
  /** Data fetched for this line, waiting for (or shifting out at) X. */
  armed = false;
  expY = false; expFlop = true;
  mc = 0; mcBase = 0;
  /** The 24 bits fetched for this line. */
  data = 0;
  /** Bits still to shift out on this line (-1: waiting for X). */
  shifting = false;
  bits = 0;
  xFlop = false; mcFlop = false;
  pixel = 0; // current 2-bit (or 1-bit) value
}

export class Vic {
  readonly frame: Uint32Array;
  readonly regs = new Uint8Array(0x40);
  raster = 0;
  /** Cycle in the line, 1-based like Bauer's tables. */
  cycle = 1;
  /** True on the cycle a frame ended (raster went back to 0). */
  frameDone = false;
  /** Lines finished since power-on. */
  frameCount = 0;
  /** The VIC wants the bus: the CPU stops at its next read. */
  ba = false;
  /** The IRQ output. */
  irq = false;
  /** The last byte the VIC read (what an open bus reads back). */
  lastBus = 0xff;

  // Raster interrupt and its latches.
  private irqFlags = 0;
  private irqMask = 0;
  private rasterCompare = 0;
  private rasterIrqDone = false;

  // Video matrix and character state (Bauer 3.7.2).
  private vc = 0; private vcBase = 0; private rc = 0; private vmli = 0;
  private displayState = false;
  private badLine = false;
  private denLatch = false;
  private readonly vmLine = new Uint16Array(40);

  // Graphics shifter.
  private gLatch = 0; private cLatch = 0; private gPending = false;
  private gShift = 0; private gColor = 0; private gMcFlop = false; private gBits = 0;

  // Border flip-flops.
  private mainBorder = true;
  private vBorder = true;

  private readonly sprites = Array.from({ length: 8 }, () => new Sprite());
  private mmCollision = 0; private mbCollision = 0;

  /** Where in `frame` the current line goes (-1 off screen). */
  private lineBase = -1;

  constructor(public timing: VicTiming, public read: VicRead) {
    this.frame = new Uint32Array(WIDTH * timing.height);
  }

  setTiming(t: VicTiming): void {
    this.timing = t;
    (this as { frame: Uint32Array }).frame = new Uint32Array(WIDTH * t.height);
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.raster = 0; this.cycle = 1;
    this.irqFlags = 0; this.irqMask = 0; this.rasterCompare = 0; this.irq = false;
    this.vc = this.vcBase = this.rc = this.vmli = 0;
    this.displayState = false; this.badLine = false; this.denLatch = false;
    this.mainBorder = this.vBorder = true;
    for (const s of this.sprites) Object.assign(s, new Sprite());
    this.mmCollision = this.mbCollision = 0;
    this.ba = false;
  }

  /** Register reads, $D000-$D3FF (64 registers, mirrored). */
  readReg(r: number): number {
    r &= 0x3f;
    const g = this.regs;
    switch (r) {
      case 0x11: return (g[0x11] & 0x7f) | ((this.raster & 0x100) >> 1);
      case 0x12: return this.raster & 0xff;
      case 0x13: case 0x14: return 0; // light pen
      case 0x16: return g[0x16] | 0xc0;
      case 0x18: return g[0x18] | 0x01;
      case 0x19: return this.irqFlags | (this.irqFlags & this.irqMask ? 0x80 : 0) | 0x70;
      case 0x1a: return this.irqMask | 0xf0;
      case 0x1e: { const v = this.mmCollision; this.mmCollision = 0; return v; }
      case 0x1f: { const v = this.mbCollision; this.mbCollision = 0; return v; }
    }
    if (r >= 0x20 && r <= 0x2e) return g[r] | 0xf0;
    if (r >= 0x2f) return 0xff;
    return g[r];
  }

  writeReg(r: number, v: number): void {
    r &= 0x3f;
    if (r >= 0x2f) return;
    const g = this.regs;
    switch (r) {
      case 0x11: case 0x12: {
        g[r] = v;
        const cmp = ((g[0x11] & 0x80) << 1) | g[0x12];
        if (cmp !== this.rasterCompare) {
          this.rasterCompare = cmp;
          // Setting the compare to the current line triggers at once.
          if (cmp === this.raster) this.rasterIrq(); else this.rasterIrqDone = false;
        }
        if (r === 0x11) this.updateBadLine();
        return;
      }
      case 0x19: this.irqFlags &= ~v & 0x0f; this.updateIrq(); return;
      case 0x1a: this.irqMask = v & 0x0f; this.updateIrq(); return;
      case 0x1e: case 0x1f: return;
    }
    g[r] = v;
    if (r < 0x10) {
      const s = this.sprites[r >> 1];
      if (r & 1) s.y = v; else s.x = (s.x & 0x100) | v;
    } else if (r === 0x10) {
      for (let i = 0; i < 8; i++) this.sprites[i].x = (this.sprites[i].x & 0xff) | ((v >> i) & 1) << 8;
    } else if (r === 0x17) {
      for (let i = 0; i < 8; i++) {
        const s = this.sprites[i];
        s.expY = !!((v >> i) & 1);
        if (!s.expY) s.expFlop = true;
      }
    }
  }

  private rasterIrq(): void {
    if (this.rasterIrqDone) return;
    this.rasterIrqDone = true;
    this.irqFlags |= 1;
    this.updateIrq();
  }
  private updateIrq(): void { this.irq = (this.irqFlags & this.irqMask) !== 0; }

  private updateBadLine(): void {
    const r = this.raster;
    this.badLine = this.denLatch && r >= 0x30 && r <= 0xf7 && (r & 7) === (this.regs[0x11] & 7);
    if (this.badLine) this.displayState = true;
  }

  /** One cycle of the VIC: fetches, BA, IRQ and the 8 pixels of this cycle. */
  tick(): void {
    const t = this.timing;
    const cyc = this.cycle;
    const g = this.regs;

    if (cyc === 1) {
      this.frameDone = false;
      if (this.raster === 0) { this.vcBase = 0; this.denLatch = false; }
      const top = this.firstLineOf();
      this.lineBase = top >= 0 ? top * WIDTH : -1;
    }
    // The raster compare fires in cycle 1 (line 0: cycle 2).
    if ((cyc === 1 && this.raster !== 0) || (cyc === 2 && this.raster === 0)) {
      if (this.raster === this.rasterCompare) this.rasterIrq();
    }
    if (this.raster === 0x30 && (g[0x11] & 0x10)) this.denLatch = true;
    this.updateBadLine();

    // Sprites: Y expansion and DMA start (Bauer 3.8.1, steps 2-3).
    if (cyc === 55) {
      for (const s of this.sprites) if (s.expY) s.expFlop = !s.expFlop;
    }
    if (cyc === 55 || cyc === 56) {
      const en = g[0x15];
      for (let i = 0; i < 8; i++) {
        const s = this.sprites[i];
        if (((en >> i) & 1) && s.y === (this.raster & 0xff) && !s.dma) {
          s.dma = true; s.mcBase = 0;
          if (s.expY) s.expFlop = false;
        }
      }
    }
    if (cyc === 58) {
      for (const s of this.sprites) {
        s.mc = s.mcBase;
        if (s.dma && s.y === (this.raster & 0xff)) s.display = true;
      }
    }
    if (cyc === 15) for (const s of this.sprites) if (s.expFlop) s.mcBase = (s.mcBase + 2) & 63;
    if (cyc === 16) {
      for (const s of this.sprites) {
        if (s.expFlop) s.mcBase = (s.mcBase + 1) & 63;
        if (s.mcBase === 63) { s.dma = false; s.display = false; }
      }
    }

    // Sprite fetches.
    for (let i = 0; i < 8; i++) {
      if (t.spriteCycle[i] !== cyc) continue;
      const s = this.sprites[i];
      const vm = (g[0x18] & 0xf0) << 6;
      const ptr = this.fetch(vm | 0x3f8 | i) & 0xff;
      if (s.dma) {
        let d = 0;
        for (let k = 0; k < 3; k++) { d = (d << 8) | (this.fetch((ptr << 6) | s.mc) & 0xff); s.mc = (s.mc + 1) & 63; }
        s.data = d;
        s.shifting = false;
        s.armed = true;
      } else {
        s.armed = false;
      }
    }

    // The character line (Bauer 3.7.2).
    if (cyc === 14) {
      this.vc = this.vcBase; this.vmli = 0;
      if (this.badLine) this.rc = 0;
    }
    if (cyc >= 16 && cyc <= 55) this.gAccess();
    if (cyc >= 15 && cyc <= 54 && this.badLine) {
      this.vmLine[this.vmli] = this.fetch(((g[0x18] & 0xf0) << 6) | this.vc) & 0xfff;
    }
    if (cyc === 58) {
      if (this.rc === 7) { this.vcBase = this.vc; if (!this.badLine) this.displayState = false; }
      if (this.displayState) this.rc = (this.rc + 1) & 7;
    }

    // BA: bad lines from cycle 12 to 54, and 3 cycles ahead of each sprite fetch.
    let ba = this.badLine && cyc >= 12 && cyc <= 54;
    if (!ba) {
      const L = t.cyclesPerLine;
      for (let i = 0; i < 8; i++) {
        if (!this.sprites[i].dma) continue;
        const d = (cyc - (t.spriteCycle[i] - 3) + L) % L;
        if (d <= 4) { ba = true; break; }
      }
    }
    this.ba = ba;

    if (cyc >= FIRST_CYCLE && cyc <= LAST_CYCLE) this.draw(cyc);

    // Vertical border checks in the last cycle (Bauer 3.9, rules 2-3).
    if (cyc === t.cyclesPerLine) {
      this.verticalBorder();
      this.cycle = 1;
      this.raster++;
      if (this.raster === t.lines) {
        this.raster = 0;
        this.frameDone = true;
        this.frameCount++;
      }
      this.rasterIrqDone = false;
    } else {
      this.cycle = cyc + 1;
    }
  }

  private firstLineOf(): number {
    const y = this.raster - this.timing.firstLine;
    return y >= 0 && y < this.timing.height ? y : -1;
  }

  private fetch(addr: number): number {
    const v = this.read(addr & 0x3fff);
    this.lastBus = v & 0xff;
    return v;
  }

  private gAccess(): void {
    const g = this.regs;
    const ecm = g[0x11] & 0x40, bmm = g[0x11] & 0x20;
    if (this.displayState) {
      const c = this.vmLine[this.vmli];
      let addr: number;
      if (bmm) addr = ((g[0x18] & 0x08) << 10) | (this.vc << 3) | this.rc;
      else addr = ((g[0x18] & 0x0e) << 10) | ((ecm ? c & 0x3f : c & 0xff) << 3) | this.rc;
      if (ecm) addr &= 0x39ff;
      this.gLatch = this.fetch(addr) & 0xff;
      this.cLatch = c;
      this.vc = (this.vc + 1) & 0x3ff;
      this.vmli = (this.vmli + 1) & 0x3f;
    } else {
      this.gLatch = this.fetch(ecm ? 0x39ff : 0x3fff) & 0xff;
      this.cLatch = 0;
    }
    this.gPending = true;
  }

  private verticalBorder(): void {
    const g = this.regs;
    const rsel = g[0x11] & 0x08;
    const top = rsel ? 51 : 55, bottom = rsel ? 251 : 247;
    if (this.raster === bottom) this.vBorder = true;
    else if (this.raster === top && (g[0x11] & 0x10)) this.vBorder = false;
  }

  /** The 8 pixels of one cycle. */
  private draw(cyc: number): void {
    const g = this.regs;
    const frame = this.frame;
    const base = this.lineBase;
    const x0 = (cyc - 13) * 8;
    const csel = g[0x16] & 0x08;
    const left = csel ? 24 : 31, right = csel ? 344 : 335;
    const rsel = g[0x11] & 0x08;
    const top = rsel ? 51 : 55, bottom = rsel ? 251 : 247;
    const xscroll = g[0x16] & 7;
    const mode = ((g[0x11] & 0x60) >> 4) | ((g[0x16] & 0x10) >> 4); // ECM BMM MCM
    const sprEnabled = this.anySpriteShowing();
    const border = g[0x20] & 15;

    for (let px = 0; px < 8; px++) {
      const X = x0 + px;

      // Border unit (Bauer 3.9).
      if (X === right) this.mainBorder = true;
      if (X === left) {
        if (this.raster === bottom) this.vBorder = true;
        else if (this.raster === top && (g[0x11] & 0x10)) this.vBorder = false;
        if (!this.vBorder) this.mainBorder = false;
      }

      // Graphics shifter.
      if (px === xscroll && this.gPending) {
        this.gShift = this.gLatch; this.gColor = this.cLatch;
        this.gPending = false; this.gMcFlop = false; this.gBits = 8;
      }
      let color: number;
      let fg = false;
      const cdata = this.gColor;
      const mc = (mode & 1) && (mode & 2 || (cdata & 0x800));
      let bits: number;
      if (mc) {
        if (!this.gMcFlop) this.gPix = (this.gShift >> 6) & 3;
        bits = this.gPix;
        this.gMcFlop = !this.gMcFlop;
        if (!this.gMcFlop) this.gShift = (this.gShift << 2) & 0xff;
        fg = bits >= 2;
      } else {
        bits = (this.gShift >> 7) & 1;
        this.gShift = (this.gShift << 1) & 0xff;
        fg = bits === 1;
      }
      switch (mode) {
        case 0: color = bits ? (cdata >> 8) & 15 : g[0x21] & 15; break;
        case 1:
          if (cdata & 0x800) color = bits === 0 ? g[0x21] & 15 : bits === 1 ? g[0x22] & 15 : bits === 2 ? g[0x23] & 15 : (cdata >> 8) & 7;
          else color = bits ? (cdata >> 8) & 7 : g[0x21] & 15;
          break;
        case 2: color = bits ? (cdata >> 4) & 15 : cdata & 15; break;
        case 3: color = bits === 0 ? g[0x21] & 15 : bits === 1 ? (cdata >> 4) & 15 : bits === 2 ? cdata & 15 : (cdata >> 8) & 15; break;
        case 4: color = bits ? (cdata >> 8) & 15 : g[0x21 + ((cdata >> 6) & 3)] & 15; break;
        default: color = 0; break; // the invalid modes draw black
      }

      // Sprites: the lowest number wins; MDP puts a sprite behind the foreground.
      if (sprEnabled) {
        let sc = -1, sp = 0, count = 0, hit = 0;
        for (let i = 7; i >= 0; i--) {
          const p = this.spritePixel(i, X);
          if (p < 0) continue;
          count++; hit |= 1 << i;
          sc = p; sp = i;
        }
        for (let i = 0; i < 8; i++) if (this.sprites[i].armed) this.advanceSprite(i, X);
        if (count) {
          if (count > 1) { if (!this.mmCollision) { this.irqFlags |= 4; this.updateIrq(); } this.mmCollision |= hit; }
          if (fg) { if (!this.mbCollision) { this.irqFlags |= 2; this.updateIrq(); } this.mbCollision |= hit; }
          if (!(fg && ((g[0x1b] >> sp) & 1))) color = sc;
        }
      }

      if (this.mainBorder || this.vBorder) color = border;
      if (base >= 0) frame[base + X + 8] = PALETTE[color];
    }
  }
  private gPix = 0;

  private anySpriteShowing(): boolean {
    for (const s of this.sprites) if (s.armed) return true;
    return false;
  }

  /** The colour sprite i shows at X, or -1 for transparent. */
  private spritePixel(i: number, X: number): number {
    const s = this.sprites[i];
    if (!s.armed) return -1;
    if (!s.shifting) {
      if (X !== s.x) return -1;
      s.shifting = true; s.bits = 24; s.xFlop = false; s.mcFlop = false;
      s.pixel = this.spriteBits(i, s);
    }
    if (s.bits <= 0) return -1;
    const v = s.pixel;
    if (v === 0) return -1;
    const g = this.regs;
    if ((g[0x1c] >> i) & 1) return v === 1 ? g[0x25] & 15 : v === 2 ? g[0x27 + i] & 15 : g[0x26] & 15;
    return g[0x27 + i] & 15;
  }
  private spriteBits(i: number, s: Sprite): number {
    const mc = (this.regs[0x1c] >> i) & 1;
    return mc ? (s.data >> 22) & 3 : (s.data >> 23) & 1;
  }
  /** Moves sprite i's shifter on by one pixel. */
  private advanceSprite(i: number, _X: number): void {
    const s = this.sprites[i];
    if (!s.shifting || s.bits <= 0) return;
    const g = this.regs;
    if ((g[0x1d] >> i) & 1) { s.xFlop = !s.xFlop; if (s.xFlop) return; }
    const mc = (g[0x1c] >> i) & 1;
    if (mc) {
      s.mcFlop = !s.mcFlop;
      if (s.mcFlop) return;
      s.data = (s.data << 2) & 0xffffff; s.bits -= 2;
    } else {
      s.data = (s.data << 1) & 0xffffff; s.bits -= 1;
    }
    s.pixel = this.spriteBits(i, s);
  }
}
