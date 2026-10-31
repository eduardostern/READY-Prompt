/**
 * The SID, 6581 or 8580: three voices, the envelope generators, the filter.
 *
 * The machine calls `advanceTo(cycle)` before each register access and at
 * the end of each frame, and the SID catches up. Each output sample is
 * the average of the voices over its ~22 cycles, taken in sub-steps of at
 * most 8 cycles (the oscillators move exactly; sync, ring modulation and
 * the noise register follow the accumulators' edges), then filtered.
 *
 * The envelope follows reSID: a 15-bit rate counter that compares for
 * equality (so lowering the rate mid-count wraps it round: the "ADSR bug"),
 * the exponential decay steps, sustain at nybble × 17.
 */

/** Cycles between envelope steps for each rate nybble (reSID). */
const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
const SUB_STEP = 8;

export type SidModel = '6581' | '8580';

const ATTACK = 0, DECAY_SUSTAIN = 1, RELEASE = 2;

class Voice {
  acc = 0;
  freq = 0;
  pw = 0;
  control = 0;
  ad = 0;
  sr = 0;
  noise = 0x7ffff8;
  /** Accumulator MSB rose in the last step (for the voice synced to this one). */
  msbRising = false;
  env = 0;
  state = RELEASE;
  rateCounter = 0;
  expCounter = 0;
  expPeriod = 1;
  holdZero = true;

  writeControl(v: number): void {
    const was = this.control & 1;
    this.control = v;
    if (v & 8) { this.acc = 0; this.noise = 0x7ffff8; }
    if ((v & 1) && !was) { this.state = ATTACK; this.holdZero = false; }
    else if (!(v & 1) && was) this.state = RELEASE;
  }

  /** The 12-bit waveform output; `ringMsb` is the ring-modulating voice's MSB. */
  wave(ringMsb: number): number {
    const c = this.control;
    const sel = c >> 4;
    if (!sel) return 0;
    let out = 0xfff;
    if (sel & 1) {
      let msb = (this.acc >> 23) & 1;
      if (c & 4) msb ^= ringMsb;
      out &= ((msb ? ~this.acc : this.acc) >> 11) & 0xfff;
    }
    if (sel & 2) out &= this.acc >> 12;
    if (sel & 4) out &= (c & 8) || (this.acc >> 12) >= this.pw ? 0xfff : 0;
    if (sel & 8) {
      const n = this.noise;
      out &= (((n >> 20) & 1) << 11) | (((n >> 18) & 1) << 10) | (((n >> 14) & 1) << 9) | (((n >> 11) & 1) << 8) |
        (((n >> 9) & 1) << 7) | (((n >> 5) & 1) << 6) | (((n >> 2) & 1) << 5) | ((n & 1) << 4);
    }
    return out;
  }

  /** Moves the oscillator on by n cycles. */
  clockOsc(n: number): void {
    if (this.control & 8) { this.msbRising = false; return; }
    const old = this.acc;
    this.acc = (old + this.freq * n) & 0xffffff;
    this.msbRising = !(old & 0x800000) && !!(this.acc & 0x800000);
    // The noise register shifts when bit 19 rises.
    if (!(old & 0x80000) && (this.acc & 0x80000)) {
      const bit = ((this.noise >> 22) ^ (this.noise >> 17)) & 1;
      this.noise = ((this.noise << 1) | bit) & 0x7fffff;
    }
  }

  /** Moves the envelope on by n cycles. */
  clockEnv(n: number): void {
    for (;;) {
      const rate = this.state === ATTACK ? this.ad >> 4 : this.state === DECAY_SUSTAIN ? this.ad & 15 : this.sr & 15;
      const period = RATE_PERIOD[rate];
      // Cycles until the counter next equals the period (it wraps at 2^15).
      let until = period - this.rateCounter;
      if (until <= 0) until += 0x8000;
      if (n < until) { this.rateCounter = (this.rateCounter + n) & 0x7fff; return; }
      n -= until;
      this.rateCounter = 0;
      this.step();
    }
  }

  private step(): void {
    if (this.state === ATTACK) {
      this.env = (this.env + 1) & 0xff;
      if (this.env === 0xff) this.state = DECAY_SUSTAIN;
      this.expCounter = 0;
      this.setExpPeriod();
      return;
    }
    if (++this.expCounter < this.expPeriod) return;
    this.expCounter = 0;
    if (this.holdZero) return;
    if (this.state === DECAY_SUSTAIN) {
      if (this.env !== (this.sr >> 4) * 17) this.env--;
    } else {
      this.env = (this.env - 1) & 0xff;
    }
    this.setExpPeriod();
    if (this.env === 0) this.holdZero = true;
  }

  private setExpPeriod(): void {
    const e = this.env;
    this.expPeriod = e >= 0x5e ? 1 : e >= 0x37 ? 2 : e >= 0x1b ? 4 : e >= 0x0f ? 8 : e >= 0x07 ? 16 : e > 0 ? 30 : 1;
  }
}

export class Sid {
  readonly regs = new Uint8Array(32);
  private voices = [new Voice(), new Voice(), new Voice()];
  model: SidModel = '6581';

  private cycle = 0;
  private cyclesPerSample: number;
  private untilSample: number;
  private accFilt = 0;
  private accDirect = 0;
  private accWeight = 0;
  private samples: number[] = [];

  // Filter state (Chamberlin state variable) and settings.
  private lp = 0; private bp = 0;
  private fc = 0; private res = 0; private route = 0; private mode = 0; private volume = 0;

  constructor(clockHz = 985248, readonly sampleRate = 44100) {
    this.cyclesPerSample = clockHz / sampleRate;
    this.untilSample = this.cyclesPerSample;
  }

  setClock(hz: number): void {
    this.cyclesPerSample = hz / this.sampleRate;
  }

  /** Starts counting from machine cycle `cycle` (after a reset or a state load). */
  sync(cycle: number): void { this.cycle = cycle; }

  reset(): void {
    this.regs.fill(0);
    this.voices = [new Voice(), new Voice(), new Voice()];
    this.lp = this.bp = 0;
    this.fc = this.res = this.route = this.mode = this.volume = 0;
  }

  /** Register reads: OSC3 and ENV3 are live, the paddles read FFh, the rest 0. */
  read(r: number): number {
    switch (r & 0x1f) {
      case 0x19: case 0x1a: return 0xff;
      case 0x1b: return this.voices[2].wave((this.voices[1].acc >> 23) & 1) >> 4;
      case 0x1c: return this.voices[2].env;
      default: return 0;
    }
  }

  write(r: number, v: number): void {
    r &= 0x1f;
    this.regs[r] = v;
    if (r < 21) {
      const voice = this.voices[(r / 7) | 0];
      switch (r % 7) {
        case 0: voice.freq = (voice.freq & 0xff00) | v; break;
        case 1: voice.freq = (voice.freq & 0xff) | (v << 8); break;
        case 2: voice.pw = (voice.pw & 0xf00) | v; break;
        case 3: voice.pw = (voice.pw & 0xff) | ((v & 15) << 8); break;
        case 4: voice.writeControl(v); break;
        case 5: voice.ad = v; break;
        case 6: voice.sr = v; break;
      }
      return;
    }
    switch (r) {
      case 21: this.fc = (this.fc & 0x7f8) | (v & 7); break;
      case 22: this.fc = (this.fc & 7) | (v << 3); break;
      case 23: this.res = v >> 4; this.route = v & 15; break;
      case 24: this.mode = v >> 4; this.volume = v & 15; break;
    }
  }

  /** Runs the SID up to machine cycle `target`. */
  advanceTo(target: number): void {
    let left = target - this.cycle;
    if (left <= 0) return;
    this.cycle = target;
    const [v0, v1, v2] = this.voices;
    while (left > 0) {
      const n = Math.max(1, Math.min(left, SUB_STEP, Math.ceil(this.untilSample)));
      v0.clockOsc(n); v1.clockOsc(n); v2.clockOsc(n);
      // Hard sync: a voice restarts when the one before it (2 → 0 → 1 → 2) overflows.
      if (v0.control & 2 && v2.msbRising) v0.acc = 0;
      if (v1.control & 2 && v0.msbRising) v1.acc = 0;
      if (v2.control & 2 && v1.msbRising) v2.acc = 0;
      v0.clockEnv(n); v1.clockEnv(n); v2.clockEnv(n);

      const o0 = (v0.wave((v2.acc >> 23) & 1) - 0x800) * v0.env;
      const o1 = (v1.wave((v0.acc >> 23) & 1) - 0x800) * v1.env;
      const o2 = (v2.wave((v1.acc >> 23) & 1) - 0x800) * v2.env;
      const route = this.route;
      let filt = 0, direct = 0;
      if (route & 1) filt += o0; else direct += o0;
      if (route & 2) filt += o1; else direct += o1;
      if (route & 4) filt += o2; else if (!(this.mode & 8)) direct += o2; // 3OFF mutes an unfiltered voice 3
      this.accFilt += filt * n;
      this.accDirect += direct * n;
      this.accWeight += n;

      left -= n;
      this.untilSample -= n;
      if (this.untilSample <= 0) {
        this.untilSample += this.cyclesPerSample;
        this.output();
      }
    }
  }

  private output(): void {
    const w = this.accWeight || 1;
    // Each voice is up to ±2048 × 255; scale three of them to about ±1.
    const scale = 1 / (2048 * 255 * 3);
    const input = (this.accFilt / w) * scale;
    const direct = (this.accDirect / w) * scale;
    this.accFilt = this.accDirect = this.accWeight = 0;

    const fcHz = this.model === '8580'
      ? 30 + this.fc * 5.8
      : 220 + 18000 * Math.pow(this.fc / 2047, 2.2);
    const f = 2 * Math.sin((Math.PI * Math.min(fcHz, this.sampleRate / 6)) / this.sampleRate);
    const q = this.model === '8580' ? 1.4 - this.res * 0.085 : 1.3 - this.res * 0.075;
    const hp = input - this.lp - q * this.bp;
    this.bp += f * hp;
    this.lp += f * this.bp;
    let filtered = 0;
    if (this.mode & 1) filtered += this.lp;
    if (this.mode & 2) filtered += this.bp;
    if (this.mode & 4) filtered += hp;

    // The 6581's volume register moves a DC level too: that step is what
    // plays $D418 samples. The 8580 has almost none.
    const dc = this.model === '6581' ? 0.25 : 0.02;
    const out = ((filtered + direct) * this.volume) / 15 + (dc * this.volume) / 15;
    this.samples.push(out * 0.8);
  }

  /** The samples made since the last call. */
  takeSamples(): Float32Array<ArrayBuffer> {
    const s = Float32Array.from(this.samples);
    this.samples.length = 0;
    return s;
  }
}
