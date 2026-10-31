/**
 * A real 1541-II on the serial bus: its own 6502 at 1 MHz running
 * Commodore's DOS ROM, 2K of RAM, two 6522s, and the disk turning under
 * the head as GCR bytes. Fast loaders, which put their own code in the
 * drive, need this; the virtual drive (drive.ts) only answers the KERNAL.
 *
 * Map: RAM 0000h-07FFh, VIA1 (serial bus) 1800h, VIA2 (disk) 1C00h, ROM
 * C000h-FFFFh (also seen at 8000h).
 *
 * VIA1 port B: 0 DATA in, 1 DATA out, 2 CLK in, 3 CLK out, 4 ATN
 * acknowledge, 5-6 device number (0 = 8), 7 ATN in; CA1 = ATN in.
 * DATA is also pulled low while ATN in and ATN acknowledge differ (the
 * 7486 that answers ATN at once, even before the DOS sees it).
 *
 * VIA2 port B: 0-1 stepper phase, 2 motor, 3 LED, 4 write protect (0 =
 * protected), 5-6 speed zone, 7 SYNC (0 = over a sync); port A the byte
 * read or to write; CA1 BYTE READY, which also sets the CPU's V flag
 * (its SO pin) while CA2 is high; CB2 low = write.
 */
import { Cpu6510 } from '../cpu6510';
import type { D64 } from './disk';
import { cyclesPerByte, decodeDisk, encodeDisk } from './gcr';
import { Via } from './via';

/** The drive's crystal: 16 MHz / 16. */
export const DRIVE_HZ = 1_000_000;

/** Serial bus lines, as bits: set = pulled low. */
export const ATN = 1, CLK = 2, DATA = 4;

export class Drive1541 {
  readonly ram = new Uint8Array(0x800);
  readonly cpu: Cpu6510;
  readonly via1: Via;
  readonly via2: Via;
  disk: D64 | null = null;
  /** The surface: GCR bytes per track (index 1-42). */
  private tracks: Uint8Array[] = [];
  /** Something was written to the surface since it was last read back into the .d64. */
  private written = false;

  /** Drive cycles run. */
  cycles = 0;
  /** Head position in half tracks (2 = track 1). */
  halfTrack = 36;
  /** Byte under the head, and time until the next one. */
  pos = 0;
  private byteTimer = 32;
  private lastByte = 0;
  /** The byte last read off the disk (port A of VIA2). */
  private readByte = 0;
  private sync = false;
  private phase = 0;

  /** VIA1 port B's pins over time (what the drive drives onto the bus). */
  readonly out = new LineLog(0xff);

  /**
   * `computer(t)` gives the lines the computer pulls low at drive cycle `t`:
   * bit 0 ATN, 1 CLK, 2 DATA (CIA2 port A bits 3-5).
   */
  constructor(private rom: Uint8Array,
    private computer: (t: number) => number) {
    this.cpu = new Cpu6510(a => { this.tick(); return this.peek(a); }, (a, v) => { this.tick(); this.poke(a, v); });
    this.via1 = new Via({
      readA: () => 0xff,
      writeB: pins => this.out.push(this.cycles, pins),
      readB: () => {
        const bus = this.lines();
        return (bus & DATA ? 0x01 : 0) | (bus & CLK ? 0x04 : 0) | (bus & ATN ? 0x80 : 0) | 0x1a;
      },
    });
    this.via2 = new Via({
      readA: () => this.readByte,
      readB: () => (this.sync ? 0 : 0x80) | 0x7f,
    });
  }

  reset(): void {
    this.via1.reset();
    this.via2.reset();
    this.out.clear(this.via1.pinsB);
    this.cpu.reset();
  }

  /** Puts a disk in (or takes it out, null), writing back what was written to the old one. */
  insert(d: D64 | null): void {
    this.flush();
    this.disk = d;
    this.tracks = d ? encodeDisk(d) : [];
    this.written = false;
    this.sync = false;
  }

  /** Reads what the drive wrote back into the .d64 (marks it dirty when anything changed). */
  flush(): void {
    if (this.written && this.disk) decodeDisk(this.tracks, this.disk);
    this.written = false;
  }

  /** The .d64 was changed from outside (the AI board, a blank disk): the surface follows it. */
  refresh(): void {
    if (this.disk) this.tracks = encodeDisk(this.disk);
    this.written = false;
  }

  get motor(): boolean { return !!(this.via2.pinsB & 0x04); }
  get led(): boolean { return !!(this.via2.pinsB & 0x08); }
  get track(): number { return this.halfTrack / 2; }

  /**
   * The lines the drive pulls low, from VIA1 port B's pins: CLK out, and
   * DATA out or the ATN answer (ATN in and ATN acknowledge differing).
   */
  static pulls(pb: number, atn: boolean): number {
    return (pb & 0x08 ? CLK : 0) | (pb & 0x02 || atn !== !!(pb & 0x10) ? DATA : 0);
  }

  /** The lines the drive pulled low at drive cycle `t` (a time it has run to). */
  pullsAt(t: number, atn: boolean): number { return Drive1541.pulls(this.out.at(t), atn); }

  /** The bus as the drive sees it now: the lines anyone pulls low. */
  private lines(): number {
    const c = this.computer(this.cycles);
    return c | Drive1541.pulls(this.via1.pinsB, !!(c & ATN));
  }

  /** Runs whole instructions while the drive is behind cycle `t`. */
  runTo(t: number): void {
    while (this.cycles < t) this.cpu.step();
  }

  /** One drive cycle. */
  private tick(): void {
    this.cycles++;
    this.via1.tick();
    this.via2.tick();
    this.via1.setCa1(!!(this.computer(this.cycles) & ATN));
    this.mechanics();
    this.cpu.irqLine = (this.via1.irq ? 1 : 0) | (this.via2.irq ? 2 : 0);
  }

  /** The stepper, and the disk passing under the head. */
  private mechanics(): void {
    const pb = this.via2.pinsB;
    const ph = pb & 3;
    if (ph !== this.phase) {
      const from = this.halfTrack;
      if (ph === ((this.phase + 1) & 3)) this.halfTrack = Math.min(84, this.halfTrack + 1);
      else if (ph === ((this.phase - 1) & 3)) this.halfTrack = Math.max(2, this.halfTrack - 1);
      this.phase = ph;
      if (from !== this.halfTrack) this.moved(from);
    }
    if (!(pb & 0x04) || --this.byteTimer > 0) return;
    this.byteTimer = cyclesPerByte((pb >> 5) & 3);
    const t = this.halfTrack & 1 ? undefined : this.tracks[this.halfTrack >> 1];
    if (!t?.length) { this.sync = false; return; }
    this.pos = (this.pos + 1) % t.length;
    if (!this.via2.cb2) {
      // Writing: the byte on port A goes onto the disk.
      t[this.pos] = this.via2.pinsA;
      this.written = true;
      this.sync = false;
      this.lastByte = t[this.pos];
      this.byteReady();
      return;
    }
    const b = t[this.pos];
    this.sync = b === 0xff && this.lastByte === 0xff;
    this.lastByte = b;
    if (this.sync) return;
    this.readByte = b;
    this.byteReady();
  }

  private byteReady(): void {
    this.via2.edgeCa1();
    if (this.via2.ca2) this.cpu.v = 1;
  }

  /** The head moved: keep the same angle on the new track. */
  private moved(from: number): void {
    const a = this.tracks[from >> 1]?.length, b = this.tracks[this.halfTrack >> 1]?.length;
    if (a && b) this.pos = Math.floor((this.pos * b) / a) % b;
  }

  private peek(a: number): number {
    if (a & 0x8000) return this.rom[a & 0x3fff];
    switch (a & 0x1c00) {
      case 0x1800: return this.via1.read(a);
      case 0x1c00: return this.via2.read(a);
      default: return a & 0x1000 ? a >> 8 : this.ram[a & 0x7ff];
    }
  }

  private poke(a: number, v: number): void {
    if (a & 0x8000) return;
    switch (a & 0x1c00) {
      case 0x1800: this.via1.write(a, v); return;
      case 0x1c00: this.via2.write(a, v); return;
      default: if (!(a & 0x1000)) this.ram[a & 0x7ff] = v;
    }
  }
}

/**
 * A bus line's changes over time, so each side can read the other's lines
 * as they were at its own moment (the drive and the computer take turns
 * running a few cycles at a time). Readers ask for times that only grow.
 */
export class LineLog {
  private t: number[] = [-Infinity];
  private v: number[] = [0];
  private i = 0;

  constructor(value = 0) { this.v[0] = value; }

  push(t: number, v: number): void {
    if (v === this.v[this.v.length - 1]) return;
    this.t.push(t); this.v.push(v);
  }

  /** The value at time `t`. */
  at(t: number): number {
    const ts = this.t;
    while (this.i + 1 < ts.length && ts[this.i + 1] <= t) this.i++;
    if (this.i > 256) { ts.splice(0, this.i); this.v.splice(0, this.i); this.i = 0; }
    return this.v[this.i];
  }

  get last(): number { return this.v[this.v.length - 1]; }

  /** Forgets the past: the line is `v` from now on. */
  clear(v: number): void { this.t = [-Infinity]; this.v = [v]; this.i = 0; }
}
