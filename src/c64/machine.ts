/**
 * The Commodore 64: a 6510, the VIC-II, the SID, two CIAs and the PLA.
 *
 * Time moves in CPU bus cycles: every access the CPU makes first runs one
 * cycle of the rest of the machine (`clock`), the VIC's half before the
 * CPU's; a read made while the VIC holds BA low waits, cycle after cycle,
 * until the VIC lets go (writes never collide: the VIC takes the bus 3
 * cycles after BA, and the 6510 never writes more than 3 times in a row).
 */

import { Cpu6510 } from '../cpu6510';
import { Cia } from './cia';
import { KEYS, Matrix, type Key } from './keyboard';
import { BASIC, CHAROM, cpuMap, IO, KERNAL, NONE, RAM, ROMH, ROML, vicChip } from './pla';
import { Sid, type SidModel } from './sid';
import { Tape } from './tape';
import { NTSC, PAL, Vic, type VicTiming } from './vic';

export type Model = 'pal' | 'ntsc';

export const CLOCK: Record<Model, number> = { pal: 985248, ntsc: 1022727 };

/** What a cartridge does on the expansion port. */
export interface Cartridge {
  /** Line levels: true = high (not pulled low). */
  game: boolean;
  exrom: boolean;
  roml(addr: number): number;
  romh(addr: number): number;
  /** Writes into the ROML/ROMH areas (only seen in Ultimax mode, or by RAM carts). */
  writeRom?(addr: number, v: number): void;
  io1Read?(addr: number): number | undefined;
  io1Write?(addr: number, v: number): void;
  io2Read?(addr: number): number | undefined;
  io2Write?(addr: number, v: number): void;
  reset?(): void;
  /** Called every cycle when present (the modem's ACIA, timers). */
  tick?(): void;
  irq?: boolean;
  nmi?: boolean;
}

export interface Roms { basic: Uint8Array; kernal: Uint8Array; chargen: Uint8Array }

/** Joystick bits as stored here (1 = pressed): up, down, left, right, fire. */
export const JOY_UP = 1, JOY_DOWN = 2, JOY_LEFT = 4, JOY_RIGHT = 8, JOY_FIRE = 16;

export class C64 {
  readonly ram = new Uint8Array(0x10000);
  readonly colorRam = new Uint8Array(0x400);
  readonly cpu: Cpu6510;
  readonly vic: Vic;
  readonly sid = new Sid(CLOCK.pal);
  readonly cia1: Cia;
  readonly cia2: Cia;
  readonly keys = new Matrix();
  basic: Uint8Array;
  kernal: Uint8Array;
  chargen: Uint8Array;
  cart: Cartridge | null = null;
  model: Model = 'pal';

  /** Cycles since power-on. */
  cycles = 0;
  /** Joysticks in ports 1 and 2. */
  joy1 = 0;
  joy2 = 0;
  /** RESTORE held. */
  restore = false;

  // The 6510's own port at 00h/01h.
  private ddr = 0;
  private data = 0;
  /** PLA mode: LORAM | HIRAM<<1 | CHAREN<<2 | GAME<<3 | EXROM<<4. */
  private mode = 31;

  // Time of day: power line ticks.
  private todPeriod = 0;
  private todNext = 0;

  /** Text waiting to be typed into the keyboard buffer. */
  private typing: number[] = [];
  /** Things to do once BASIC waits at READY. (a program to drop in). */
  private onReady: (() => void)[] = [];

  /** The cassette in the Datasette. */
  tape: Tape | null = null;
  /** PLAY is down (the port's sense bit reads 0). */
  tapePlay = false;
  /** LOAD and SAVE on tape happen at once through the KERNAL traps. */
  fastTape = true;
  /** The motor runs (port bit 5 low as an output). */
  private motorOn = false;

  /** KERNAL entry points handled here when the KERNAL is mapped in: address → handler. */
  private readonly trapAt = new Uint8Array(0x10000);
  private readonly traps = new Map<number, () => boolean>();

  constructor(roms: Roms) {
    this.basic = roms.basic;
    this.kernal = roms.kernal;
    this.chargen = roms.chargen;
    this.cpu = new Cpu6510(a => this.cpuRead(a), (a, v) => this.cpuWrite(a, v));
    this.vic = new Vic(PAL, a => this.vicRead(a));
    this.cia1 = new Cia({
      readA: out => out & ~this.keys.columns(this.cia1.pinsB) & ~this.joy2,
      readB: out => out & ~this.keys.rows(this.cia1.pinsA) & ~this.joy1,
    });
    this.cia2 = new Cia({
      // IEC: the C64 drives ATN/CLK/DATA through inverters (bits 3-5);
      // with no other device the lines read back what it drives (bits 6-7).
      readA: out => (out & 0x3f) | (out & 0x10 ? 0 : 0x40) | (out & 0x20 ? 0 : 0x80),
      readB: out => out,
    });
    this.addTrap(0xf4a5, () => this.loadTrap());
    this.addTrap(0xf5ed, () => this.saveTrap());
    this.reset(true);
  }

  /** Runs `fn` instead of the KERNAL at `addr` (when it returns true). */
  addTrap(addr: number, fn: () => boolean): void {
    this.trapAt[addr] = 1;
    this.traps.set(addr, fn);
  }

  setModel(m: Model): void {
    this.model = m;
    this.vic.setTiming(m === 'pal' ? PAL : NTSC);
    this.sid.setClock(CLOCK[m]);
    this.reset(true);
  }

  /** The SID chip: the 6581 of the first C64s or the C64C's 8580. */
  setSidModel(m: SidModel): void { this.sid.model = m; }

  /** The sound made since the last call (44.1 kHz). */
  takeAudio(): Float32Array<ArrayBuffer> { return this.sid.takeSamples(); }

  get timing(): VicTiming { return this.vic.timing; }
  get clockHz(): number { return CLOCK[this.model]; }

  /** Power-on (`cold`) clears RAM to the usual pattern; a reset keeps it. */
  reset(cold = false): void {
    if (cold) {
      // RAM powers up in stripes: 64 bytes of 00h, 64 of FFh.
      for (let a = 0; a < 0x10000; a++) this.ram[a] = a & 0x40 ? 0xff : 0x00;
      for (let a = 0; a < 0x400; a++) this.colorRam[a] = (a * 7) & 15;
    }
    this.ddr = 0; this.data = 0;
    this.motorOn = false;
    this.updateMode();
    this.vic.reset();
    this.sid.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.cart?.reset?.();
    this.updateMode();
    this.typing = [];
    this.onReady = [];
    // The power line: 50 Hz for PAL machines, 60 for NTSC.
    this.todPeriod = Math.round(this.clockHz / (this.model === 'pal' ? 50 : 60));
    this.todNext = this.cycles + this.todPeriod;
    this.cpu.reset();
  }

  /** Plugs in (or pulls out) a cartridge; the caller resets. */
  insert(cart: Cartridge | null): void {
    this.cart = cart;
    this.updateMode();
  }

  /** The cartridge changed GAME/EXROM (bank-switching carts call this). */
  updateMode(): void {
    const pins = (this.data | ~this.ddr) & 7;
    const game = this.cart ? this.cart.game : true;
    const exrom = this.cart ? this.cart.exrom : true;
    this.mode = pins | (game ? 8 : 0) | (exrom ? 16 : 0);
  }

  /** The 6510 port as read at 01h. */
  private portRead(): number {
    // Bits 0-2 are pulled up, bit 4 is the cassette sense (0 = a button down),
    // bit 5 the motor (pulled low when it is an input).
    const inputs = 0x07 | (this.tapePlay ? 0 : 0x10);
    return (this.data & this.ddr) | (inputs & ~this.ddr) & 0xff;
  }

  /** The cassette motor is on (port bit 5 an output, and low). */
  get motor(): boolean { return this.motorOn; }

  /** The Datasette is turning: PLAY down and the motor on. */
  get tapeRunning(): boolean { return this.motorOn && this.tapePlay && !!this.tape && !this.tape.atEnd; }

  // ---- The bus ----

  /** One cycle of everything but the CPU. */
  private clock(): void {
    this.vic.tick();
    this.cia1.tick();
    this.cia2.tick();
    this.cart?.tick?.();
    if (this.motorOn && this.tapePlay && this.tape && this.tape.tick()) this.cia1.flag();
    this.cycles++;
    if (this.cycles >= this.todNext) {
      this.todNext += this.todPeriod;
      this.cia1.todTick(50);
      this.cia2.todTick(50);
    }
    this.cpu.irqLine = (this.vic.irq ? 1 : 0) | (this.cia1.irq ? 2 : 0) | (this.cart?.irq ? 4 : 0);
    this.cpu.setNmi(this.cia2.irq || this.restore || !!this.cart?.nmi);
  }

  private cpuRead(a: number): number {
    this.clock();
    while (this.vic.ba) this.clock();
    return this.peek(a);
  }

  private cpuWrite(a: number, v: number): void {
    this.clock();
    this.poke(a, v);
  }

  /** What the CPU reads at `a` (with the side effects of reading I/O). */
  peek(a: number): number {
    if (a < 2) return a === 0 ? this.ddr : this.portRead();
    switch (cpuMap[this.mode * 32 + (a >> 12) * 2]) {
      case RAM: return this.ram[a];
      case BASIC: return this.basic[a & 0x1fff];
      case KERNAL: return this.kernal[a & 0x1fff];
      case CHAROM: return this.chargen[a & 0x0fff];
      case IO: return this.ioRead(a);
      case ROML: return this.cart ? this.cart.roml(a) : this.vic.lastBus;
      case ROMH: return this.cart ? this.cart.romh(a) : this.vic.lastBus;
      default: return this.vic.lastBus;
    }
  }

  poke(a: number, v: number): void {
    if (a < 2) {
      if (a === 0) this.ddr = v; else this.data = v;
      this.ram[a] = this.vic.lastBus;
      this.motorOn = !!(this.ddr & 0x20) && !(this.data & 0x20);
      this.updateMode();
      return;
    }
    switch (cpuMap[this.mode * 32 + (a >> 12) * 2 + 1]) {
      case RAM: this.ram[a] = v; return;
      case IO: this.ioWrite(a, v); return;
      case ROML: case ROMH: this.cart?.writeRom?.(a, v); return;
      case NONE: return;
      default: this.ram[a] = v; return;
    }
  }

  private ioRead(a: number): number {
    switch ((a >> 8) & 0x0f) {
      case 0: case 1: case 2: case 3: return this.vic.readReg(a);
      case 4: case 5: case 6: case 7: this.sid.advanceTo(this.cycles); return this.sid.read(a);
      case 8: case 9: case 10: case 11: return (this.vic.lastBus & 0xf0) | this.colorRam[a & 0x3ff];
      case 12: return this.cia1.read(a);
      case 13: return this.cia2.read(a);
      case 14: return this.cart?.io1Read?.(a) ?? this.vic.lastBus;
      default: return this.cart?.io2Read?.(a) ?? this.vic.lastBus;
    }
  }

  private ioWrite(a: number, v: number): void {
    switch ((a >> 8) & 0x0f) {
      case 0: case 1: case 2: case 3: this.vic.writeReg(a, v); return;
      case 4: case 5: case 6: case 7: this.sid.advanceTo(this.cycles); this.sid.write(a, v); return;
      case 8: case 9: case 10: case 11: this.colorRam[a & 0x3ff] = v & 15; return;
      case 12: this.cia1.write(a, v); return;
      case 13: this.cia2.write(a, v); return;
      case 14: this.cart?.io1Write?.(a, v); return;
      default: this.cart?.io2Write?.(a, v); return;
    }
  }

  /** The VIC's 14-bit address in the bank CIA2 picks; colour RAM on bits 8-11. */
  private vicRead(addr: number): number {
    const full = ((~this.cia2.pinsA & 3) << 14) | addr;
    const game = this.cart ? this.cart.game : true;
    const exrom = this.cart ? this.cart.exrom : true;
    const chip = vicChip(game, exrom, !(full & 0x4000), !!(full & 0x2000), !!(full & 0x1000));
    let v: number;
    if (chip === CHAROM) v = this.chargen[full & 0x0fff];
    else if (chip === ROMH) v = this.cart ? this.cart.romh(0xf000 | (full & 0x0fff)) : 0xff;
    else v = this.ram[full];
    return v | (this.colorRam[addr & 0x3ff] << 8);
  }

  // ---- Running ----

  /** Runs until the VIC finishes the frame it is drawing. */
  runFrame(): void {
    const f = this.vic.frameCount;
    const cpu = this.cpu;
    while (this.vic.frameCount === f) {
      const pc = cpu.pc;
      if (this.trapAt[pc] && !cpu.interruptPending && this.kernalIn() && this.traps.get(pc)!()) continue;
      cpu.step();
    }
    if (this.onReady.length && this.atPrompt) this.onReady.shift()!();
    this.feedTyping();
    this.sid.advanceTo(this.cycles);
  }

  /** The KERNAL is in its loop waiting for a key (E5CDh-E5D5h) with nothing typed. */
  get atPrompt(): boolean {
    return this.cpu.pc >= 0xe5cd && this.cpu.pc <= 0xe5d5 && !this.typing.length && this.ram[0xc6] === 0;
  }

  /** Runs `fn` at the end of the first frame BASIC is idle at its prompt (now, if it is). */
  whenReady(fn: () => void): void {
    this.onReady.push(fn);
  }

  /** Runs about `n` frames (for tests and fast-forward). */
  run(frames: number): void {
    for (let i = 0; i < frames; i++) this.runFrame();
  }

  /** The KERNAL ROM is what the CPU sees at E000h. */
  private kernalIn(): boolean { return cpuMap[this.mode * 32 + 0xe * 2] === KERNAL; }

  // ---- Tape traps ----

  /** The file name LOAD/SAVE were given (FNLEN B7h, FNADR BBh). */
  private fileName(): Uint8Array {
    const len = this.ram[0xb7], at = this.ram[0xbb] | (this.ram[0xbc] << 8);
    return this.ram.slice(at, at + len);
  }

  /** KERNAL LOAD (F4A5h) from the tape: the next matching file, at once. */
  private loadTrap(): boolean {
    if (this.ram[0xba] !== 1 || !this.fastTape || !this.tape) return false;
    const f = this.tape.findFile(this.fileName());
    if (!f) return false; // not in the KERNAL's format: let the KERNAL read it in real time
    const verify = this.cpu.a !== 0;
    const sa = this.ram[0xb9];
    const at = f.type === 1 && sa === 0 ? this.ram[0xc3] | (this.ram[0xc4] << 8) : f.start;
    const end = Math.min(0x10000, at + f.data.length);
    if (!verify) this.ram.set(f.data.subarray(0, end - at), at);
    this.ram[0xae] = end & 0xff; this.ram[0xaf] = (end >> 8) & 0xff;
    this.ram[0x90] = 0;
    this.tape.seek(f.pulseEnd);
    this.cpu.x = end & 0xff; this.cpu.y = (end >> 8) & 0xff; this.cpu.c = 0;
    this.cpu.returnFromTrap(a => this.ram[a]);
    return true;
  }

  /** KERNAL SAVE (F5EDh) to the tape: written where the tape is. */
  private saveTrap(): boolean {
    if (this.ram[0xba] !== 1 || !this.fastTape || !this.tape) return false;
    const start = this.ram[0xc1] | (this.ram[0xc2] << 8);
    const end = this.ram[0xae] | (this.ram[0xaf] << 8);
    if (end <= start) return false;
    const type = this.ram[0xb9] & 1 ? 3 : 1;
    this.tape.record(type, start, this.ram.slice(start, end), this.fileName());
    this.ram[0x90] = 0;
    this.cpu.c = 0;
    this.cpu.returnFromTrap(a => this.ram[a]);
    return true;
  }

  setKeys(keys: Iterable<Key>): void { this.keys.set(keys); }

  // ---- Typing ----

  /** Types text as if from the keyboard (into the KERNAL's buffer). */
  type(text: string): void {
    for (const ch of text) {
      const p = asciiToPetscii(ch);
      if (p >= 0) this.typing.push(p);
    }
  }

  get typingDone(): boolean { return this.typing.length === 0; }

  /** Fills the keyboard buffer (0277h, count in C6h) whenever the KERNAL has emptied it. */
  private feedTyping(): void {
    if (!this.typing.length || this.ram[0xc6] !== 0) return;
    const n = Math.min(this.typing.length, this.ram[0x289] || 10);
    for (let i = 0; i < n; i++) this.ram[0x277 + i] = this.typing[i];
    this.typing.splice(0, n);
    this.ram[0xc6] = n;
  }

  /** The text screen as ASCII (25 lines of 40), read through the VIC's video matrix. */
  screenText(): string {
    const bank = (~this.cia2.pinsA & 3) << 14;
    const vm = bank | ((this.vic.regs[0x18] & 0xf0) << 6);
    const lines: string[] = [];
    for (let r = 0; r < 25; r++) {
      let s = '';
      for (let c = 0; c < 40; c++) s += screenCodeToAscii(this.ram[(vm + r * 40 + c) & 0xffff]);
      lines.push(s.trimEnd());
    }
    return lines.join('\n');
  }
}

/** ASCII to PETSCII, as the keyboard would type it. */
export function asciiToPetscii(ch: string): number {
  if (ch === '\n' || ch === '\r') return 13;
  const c = ch.charCodeAt(0);
  // Listings are upper case: both cases type the plain (unshifted) letter.
  if (c >= 0x61 && c <= 0x7a) return c - 0x20;
  if (c >= 0x20 && c <= 0x5d) return c;
  if (ch === '£') return 0x5c;
  if (ch === '^') return 0x5e;
  if (ch === '_') return 0x5f;
  return -1;
}

/** Screen code (upper case set) to ASCII; reversed characters as plain. */
export function screenCodeToAscii(code: number): string {
  const c = code & 0x7f;
  if (c === 0) return '@';
  if (c <= 26) return String.fromCharCode(0x40 + c);
  if (c === 28) return '£';
  if (c === 30) return '^';
  if (c === 31) return '_';
  if (c < 64) return String.fromCharCode(c);
  return ' ';
}

export { KEYS };
