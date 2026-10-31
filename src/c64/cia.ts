/**
 * MOS 6526 CIA, run one cycle at a time.
 *
 * The timers follow the real chip's pipeline: a start, a forced load or an
 * underflow takes effect a cycle or two later, kept as bits that shift
 * along a delay word each cycle (the scheme of Hoxs64 and VirtualC64).
 * The interrupt line goes low one cycle after the flag is set.
 */

// Delay word bits: each stage moves to the next bit every cycle.
const COUNT_A0 = 1 << 0, COUNT_A1 = 1 << 1, COUNT_A2 = 1 << 2, COUNT_A3 = 1 << 3;
const COUNT_B0 = 1 << 4, COUNT_B1 = 1 << 5, COUNT_B2 = 1 << 6, COUNT_B3 = 1 << 7;
const LOAD_A0 = 1 << 8, LOAD_A1 = 1 << 9, LOAD_B0 = 1 << 10, LOAD_B1 = 1 << 11;
const INT0 = 1 << 12, INT1 = 1 << 13;
const ONESHOT_A0 = 1 << 14, ONESHOT_B0 = 1 << 16;
const READ_ICR0 = 1 << 18;
/** After the shift: first stages come only from `feed`, nothing runs off the top. */
const DELAY_MASK = ~(COUNT_A0 | COUNT_B0 | LOAD_A0 | LOAD_B0 | INT0 | ONESHOT_A0 | ONESHOT_B0 | READ_ICR0) & 0xfffff;

export interface CiaPorts {
  /** Lines driven from outside on port A/B (1 = high), given the chip's own output. */
  readA(out: number): number;
  readB(out: number): number;
  /** The port's pins changed (output value with inputs pulled high). */
  writeA?(pins: number): void;
  writeB?(pins: number): void;
}

export class Cia {
  pra = 0; prb = 0; ddra = 0; ddrb = 0;
  private ta = 0xffff; private tb = 0xffff;
  private latchA = 0xffff; private latchB = 0xffff;
  private cra = 0; private crb = 0;
  private icr = 0; private imr = 0;
  private delay = 0; private feed = 0;
  /** The IRQ (CIA1) or NMI (CIA2) output, true = low. */
  irq = false;
  /** PB6/PB7 timer outputs, toggle state. */
  private pb67Toggle = 0;
  private pb67Pulse = 0;

  // Time of day, in BCD: tenths, seconds, minutes, hours (bit 7 = PM).
  private tod = [0, 0, 0, 1];
  private alarm = [0, 0, 0, 0];
  private latch: number[] | null = null;
  private todStopped = true;
  private todDivider = 0;
  private sdr = 0;

  constructor(private ports: CiaPorts) {}

  reset(): void {
    this.pra = this.prb = this.ddra = this.ddrb = 0;
    this.ta = this.tb = this.latchA = this.latchB = 0xffff;
    this.cra = this.crb = this.icr = this.imr = 0;
    this.delay = this.feed = 0;
    this.irq = false;
    this.pb67Toggle = this.pb67Pulse = 0;
    this.tod = [0, 0, 0, 1]; this.alarm = [0, 0, 0, 0];
    this.latch = null; this.todStopped = true; this.todDivider = 0;
  }

  /** Port A's pins: outputs where DDR is 1, pulled up elsewhere. */
  get pinsA(): number { return (this.pra | ~this.ddra) & 0xff; }
  get pinsB(): number {
    let v = (this.prb | ~this.ddrb) & 0xff;
    if (this.cra & 0x02) v = (v & ~0x40) | (this.timerOut(this.cra, 0x40) ? 0x40 : 0);
    if (this.crb & 0x02) v = (v & ~0x80) | (this.timerOut(this.crb, 0x80) ? 0x80 : 0);
    return v;
  }
  private timerOut(cr: number, bit: number): boolean {
    return cr & 0x04 ? !!(this.pb67Toggle & bit) : !!(this.pb67Pulse & bit);
  }

  read(r: number): number {
    switch (r & 15) {
      case 0: return this.ports.readA(this.pinsA) & 0xff;
      case 1: return this.ports.readB(this.pinsB) & 0xff;
      case 2: return this.ddra;
      case 3: return this.ddrb;
      case 4: return this.ta & 0xff;
      case 5: return this.ta >> 8;
      case 6: return this.tb & 0xff;
      case 7: return this.tb >> 8;
      case 8: { const v = (this.latch ?? this.tod)[0]; this.latch = null; return v; }
      case 9: return (this.latch ?? this.tod)[1];
      case 10: return (this.latch ?? this.tod)[2];
      case 11: this.latch = [...this.tod]; return this.latch[3];
      case 12: return this.sdr;
      case 13: {
        const v = this.icr | (this.irq ? 0x80 : 0);
        this.icr = 0;
        this.irq = false;
        this.delay &= ~(INT0 | INT1);
        this.delay |= READ_ICR0;
        return v;
      }
      case 14: return this.cra & ~0x10;
      default: return this.crb & ~0x10;
    }
  }

  write(r: number, v: number): void {
    switch (r & 15) {
      case 0: this.pra = v; this.ports.writeA?.(this.pinsA); return;
      case 1: this.prb = v; this.ports.writeB?.(this.pinsB); return;
      case 2: this.ddra = v; this.ports.writeA?.(this.pinsA); return;
      case 3: this.ddrb = v; this.ports.writeB?.(this.pinsB); return;
      case 4: this.latchA = (this.latchA & 0xff00) | v; return;
      case 5:
        this.latchA = (this.latchA & 0xff) | (v << 8);
        // A stopped timer loads its latch when the high byte is written.
        if (!(this.cra & 1)) this.delay |= LOAD_A0;
        return;
      case 6: this.latchB = (this.latchB & 0xff00) | v; return;
      case 7:
        this.latchB = (this.latchB & 0xff) | (v << 8);
        if (!(this.crb & 1)) this.delay |= LOAD_B0;
        return;
      case 8: case 9: case 10: case 11: this.writeTod(r & 15, v); return;
      case 12:
        this.sdr = v;
        // Serial out: the byte goes in 8 timer A underflows; we end it at once.
        if (this.cra & 0x40) { this.icr |= 0x08; if (this.imr & 0x08) this.delay |= INT0; }
        return;
      case 13:
        if (v & 0x80) this.imr |= v & 0x1f; else this.imr &= ~v & 0x1f;
        if (this.icr & this.imr & 0x1f) this.delay |= INT0;
        return;
      case 14:
        if ((v & 1) && !(this.cra & 1)) this.pb67Toggle |= 0x40;
        if (v & 0x10) this.delay |= LOAD_A0;
        if ((v & 0x21) === 0x01) this.feed |= COUNT_A0; else { this.feed &= ~COUNT_A0; this.delay &= ~COUNT_A0; }
        if (v & 0x08) this.feed |= ONESHOT_A0; else this.feed &= ~ONESHOT_A0;
        this.cra = v & ~0x10;
        return;
      default:
        if ((v & 1) && !(this.crb & 1)) this.pb67Toggle |= 0x80;
        if (v & 0x10) this.delay |= LOAD_B0;
        if ((v & 0x61) === 0x01) this.feed |= COUNT_B0; else { this.feed &= ~COUNT_B0; this.delay &= ~COUNT_B0; }
        if (v & 0x08) this.feed |= ONESHOT_B0; else this.feed &= ~ONESHOT_B0;
        this.crb = v & ~0x10;
        return;
    }
  }

  /** The FLAG pin saw a falling edge (the cassette read line on CIA1, RS-232 RX on CIA2). */
  flag(): void {
    this.icr |= 0x10;
    if (this.imr & 0x10) this.delay |= INT0;
  }

  /** One φ2 cycle. */
  tick(): void {
    let d = this.delay;
    if (d & COUNT_A3) this.ta = (this.ta - 1) & 0xffff;
    const outA = this.ta === 0 && !!(d & COUNT_A2);
    this.pb67Pulse = 0;
    if (outA) {
      this.icr |= 0x01;
      this.pb67Toggle ^= 0x40; this.pb67Pulse |= 0x40;
      if ((d | this.feed) & ONESHOT_A0) {
        this.cra &= ~1;
        d &= ~(COUNT_A2 | COUNT_A1 | COUNT_A0);
        this.feed &= ~COUNT_A0;
      }
      // Timer B counting timer A's underflows.
      if ((this.crb & 0x61) === 0x41) d |= COUNT_B1;
      d |= LOAD_A1;
    }
    if (d & LOAD_A1) { this.ta = this.latchA; d &= ~COUNT_A2; }

    if (d & COUNT_B3) this.tb = (this.tb - 1) & 0xffff;
    const outB = this.tb === 0 && !!(d & COUNT_B2);
    if (outB) {
      this.icr |= 0x02;
      this.pb67Toggle ^= 0x80; this.pb67Pulse |= 0x80;
      if ((d | this.feed) & ONESHOT_B0) {
        this.crb &= ~1;
        d &= ~(COUNT_B2 | COUNT_B1 | COUNT_B0);
        this.feed &= ~COUNT_B0;
      }
      d |= LOAD_B1;
    }
    if (d & LOAD_B1) { this.tb = this.latchB; d &= ~COUNT_B2; }

    if ((outA && (this.imr & 1)) || (outB && (this.imr & 2))) d |= INT0;
    if (d & INT1) this.irq = true;

    this.delay = ((d << 1) & DELAY_MASK) | this.feed;
  }

  /** One tick of the 50/60 Hz power line that drives the clock. */
  todTick(powerHz: number): void {
    if (this.todStopped) return;
    // CRA bit 7 says whether the line is 50 Hz; a mismatch makes the clock run fast or slow.
    const div = this.cra & 0x80 ? 5 : 6;
    void powerHz;
    if (++this.todDivider < div) return;
    this.todDivider = 0;
    const t = this.tod;
    t[0] = (t[0] + 1) & 0x0f;
    if (t[0] === 10) {
      t[0] = 0;
      t[1] = bcdInc(t[1]);
      if (t[1] === 0x60) {
        t[1] = 0;
        t[2] = bcdInc(t[2]);
        if (t[2] === 0x60) {
          t[2] = 0;
          const pm = t[3] & 0x80;
          let h = t[3] & 0x1f;
          if (h === 0x11) { t[3] = (pm ^ 0x80) | 0x12; }
          else if (h === 0x12) { t[3] = pm | 0x01; }
          else { h = bcdInc(h); t[3] = pm | h; }
        }
      }
    }
    if (t[0] === this.alarm[0] && t[1] === this.alarm[1] && t[2] === this.alarm[2] && t[3] === this.alarm[3]) {
      this.icr |= 0x04;
      if (this.imr & 0x04) this.delay |= INT0;
    }
  }

  private writeTod(r: number, v: number): void {
    const target = this.crb & 0x80 ? this.alarm : this.tod;
    const i = r - 8;
    const masks = [0x0f, 0x7f, 0x7f, 0x9f];
    v &= masks[i];
    if (i === 3 && !(this.crb & 0x80)) {
      // Writing 12 AM/PM flips the PM bit on the real chip.
      if ((v & 0x1f) === 0x12) v ^= 0x80;
      this.todStopped = true;
    }
    target[i] = v;
    if (i === 0 && !(this.crb & 0x80)) { this.todStopped = false; this.todDivider = 0; }
  }
}

function bcdInc(v: number): number {
  v++;
  if ((v & 0x0f) === 0x0a) v = (v & 0xf0) + 0x10;
  return v;
}
