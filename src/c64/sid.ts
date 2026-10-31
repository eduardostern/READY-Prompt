/** SID 6581/8580 (registers only until the sound engine lands). */
export class Sid {
  readonly regs = new Uint8Array(32);
  reset(): void { this.regs.fill(0); }
  read(r: number): number {
    r &= 0x1f;
    if (r === 0x19 || r === 0x1a) return 0xff; // paddles: nothing plugged in
    if (r === 0x1b || r === 0x1c) return 0;
    return 0;
  }
  write(r: number, v: number): void { this.regs[r & 0x1f] = v; }
  advanceTo(_cycles: number): void {}
}
