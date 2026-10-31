/**
 * MOS 6522 VIA, as the 1541 uses it: two ports, two timers, the CA1/CB1
 * interrupt inputs, CA2/CB2 as plain outputs, port A latching. The shift
 * register only stores what is written (the 1541 does not use it).
 *
 * Timer 1 always reloads from its latch after it passes zero (a free-run
 * period is latch + 2 cycles); timer 2 counts on, one-shot.
 */

export interface ViaPorts {
  /** Lines driven from outside on port A/B (1 = high), given the chip's own pins. */
  readA(pins: number): number;
  readB(pins: number): number;
  /** Port B's pins changed. */
  writeB?(pins: number): void;
}

const IFR_CA2 = 0x01, IFR_CA1 = 0x02, IFR_CB2 = 0x08, IFR_CB1 = 0x10, IFR_T2 = 0x20, IFR_T1 = 0x40;

export class Via {
  ora = 0; orb = 0; ddra = 0; ddrb = 0;
  t1c = 0xffff; t1l = 0xffff;
  t2c = 0xffff; t2l = 0xff;
  sr = 0; acr = 0; pcr = 0; ifr = 0; ier = 0;
  /** Timer 1 / 2 will set their flag when they next pass zero. */
  private t1On = false; private t2On = false;
  /** A counter was just written: it does not count this cycle. */
  private t1Hold = false; private t2Hold = false;
  /** Timer 1 passed zero: the latch goes in next cycle. */
  private t1Reload = false;
  private ca1 = false; private cb1 = false;
  /** Port A as latched by the last CA1 edge. */
  private paLatch = 0xff;

  constructor(private ports: ViaPorts) {}

  reset(): void {
    this.ora = this.orb = this.ddra = this.ddrb = 0;
    this.t1c = this.t1l = this.t2c = 0xffff; this.t2l = 0xff;
    this.sr = this.acr = this.pcr = this.ifr = this.ier = 0;
    this.t1On = this.t2On = this.t1Hold = this.t2Hold = this.t1Reload = false;
    this.paLatch = 0xff;
    this.ports.writeB?.(this.pinsB);
  }

  /** The pins as the chip drives them (inputs float high). */
  get pinsA(): number { return (this.ora | ~this.ddra) & 0xff; }
  get pinsB(): number { return (this.orb | ~this.ddrb) & 0xff; }
  /** CA2 / CB2 levels: low only in the "output low" mode (110). */
  get ca2(): boolean { return (this.pcr & 0x0e) !== 0x0c; }
  get cb2(): boolean { return (this.pcr & 0xe0) !== 0xc0; }
  /** The IRQ output (true = low). */
  get irq(): boolean { return (this.ifr & this.ier & 0x7f) !== 0; }

  /** One cycle. */
  tick(): void {
    if (this.t1Hold) this.t1Hold = false;
    else if (this.t1Reload) { this.t1c = this.t1l; this.t1Reload = false; }
    else {
      this.t1c = (this.t1c - 1) & 0xffff;
      if (this.t1c === 0xffff) {
        if (this.t1On) {
          this.ifr |= IFR_T1;
          if (!(this.acr & 0x40)) this.t1On = false;
        }
        this.t1Reload = true;
      }
    }
    if (this.t2Hold) this.t2Hold = false;
    else if (!(this.acr & 0x20)) {
      this.t2c = (this.t2c - 1) & 0xffff;
      if (this.t2c === 0xffff && this.t2On) { this.ifr |= IFR_T2; this.t2On = false; }
    }
  }

  /** The CA1 input; the active edge (PCR bit 0: 1 = rising) sets the flag and latches port A. */
  setCa1(high: boolean): void {
    if (high === this.ca1) return;
    this.ca1 = high;
    if (high === !!(this.pcr & 0x01)) this.edgeCa1();
  }

  /** An active CA1 edge, given as a pulse (the 1541's BYTE READY). */
  edgeCa1(): void {
    this.ifr |= IFR_CA1;
    if (this.acr & 0x01) this.paLatch = this.readPortA();
  }

  setCb1(high: boolean): void {
    if (high === this.cb1) return;
    this.cb1 = high;
    if (high === !!(this.pcr & 0x10)) this.ifr |= IFR_CB1;
  }

  private readPortA(): number {
    return (this.ora & this.ddra) | (this.ports.readA(this.pinsA) & ~this.ddra & 0xff);
  }

  read(a: number): number {
    switch (a & 15) {
      case 0: {
        this.ifr &= ~(IFR_CB1 | ((this.pcr & 0xa0) === 0x20 ? 0 : IFR_CB2));
        return (this.orb & this.ddrb) | (this.ports.readB(this.pinsB) & ~this.ddrb & 0xff);
      }
      case 1:
        this.ifr &= ~(IFR_CA1 | ((this.pcr & 0x0a) === 0x02 ? 0 : IFR_CA2));
        return this.acr & 0x01 ? this.paLatch : this.readPortA();
      case 2: return this.ddrb;
      case 3: return this.ddra;
      case 4: this.ifr &= ~IFR_T1; return this.t1c & 0xff;
      case 5: return this.t1c >> 8;
      case 6: return this.t1l & 0xff;
      case 7: return this.t1l >> 8;
      case 8: this.ifr &= ~IFR_T2; return this.t2c & 0xff;
      case 9: return this.t2c >> 8;
      case 10: return this.sr;
      case 11: return this.acr;
      case 12: return this.pcr;
      case 13: return this.ifr | (this.irq ? 0x80 : 0);
      case 14: return this.ier | 0x80;
      default: return this.acr & 0x01 ? this.paLatch : this.readPortA();
    }
  }

  write(a: number, v: number): void {
    switch (a & 15) {
      case 0: this.orb = v; this.ifr &= ~(IFR_CB1 | ((this.pcr & 0xa0) === 0x20 ? 0 : IFR_CB2)); this.ports.writeB?.(this.pinsB); return;
      case 1: this.ora = v; this.ifr &= ~(IFR_CA1 | ((this.pcr & 0x0a) === 0x02 ? 0 : IFR_CA2)); return;
      case 2: this.ddrb = v; this.ports.writeB?.(this.pinsB); return;
      case 3: this.ddra = v; return;
      case 4: case 6: this.t1l = (this.t1l & 0xff00) | v; return;
      case 5:
        this.t1l = (this.t1l & 0xff) | (v << 8);
        this.t1c = this.t1l;
        this.ifr &= ~IFR_T1;
        this.t1On = true; this.t1Hold = true; this.t1Reload = false;
        return;
      case 7: this.t1l = (this.t1l & 0xff) | (v << 8); this.ifr &= ~IFR_T1; return;
      case 8: this.t2l = v; return;
      case 9:
        this.t2c = this.t2l | (v << 8);
        this.ifr &= ~IFR_T2;
        this.t2On = true; this.t2Hold = true;
        return;
      case 10: this.sr = v; return;
      case 11: this.acr = v; return;
      case 12: this.pcr = v; return;
      case 13: this.ifr &= ~v & 0x7f; return;
      case 14: if (v & 0x80) this.ier |= v & 0x7f; else this.ier &= ~v & 0x7f; return;
      default: this.ora = v; return;
    }
  }
}
