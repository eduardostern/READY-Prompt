import { describe, expect, it } from 'vitest';
import { Cia } from '../src/c64/cia';

const cia = () => new Cia({ readA: o => o, readB: o => o });

describe('CIA', () => {
  it('underflows every latch + 1 cycles in continuous mode, and raises the IRQ', () => {
    const c = cia();
    c.write(4, 9); c.write(5, 0); // latch 9, loaded (timer stopped)
    c.write(13, 0x81);
    c.write(14, 0x01); // start, continuous
    const irqs: number[] = [];
    for (let t = 1; t <= 60; t++) {
      c.tick();
      if (c.irq) { irqs.push(t); c.read(13); }
    }
    expect(irqs.length).toBeGreaterThan(3);
    for (let i = 1; i < irqs.length; i++) expect(irqs[i] - irqs[i - 1]).toBe(10);
  });

  it('stops after one underflow in one-shot mode', () => {
    const c = cia();
    c.write(4, 5); c.write(5, 0);
    c.write(14, 0x09);
    let n = 0;
    for (let t = 0; t < 100; t++) { c.tick(); if (c.read(13) & 1) n++; }
    expect(n).toBe(1);
    expect(c.read(14) & 1).toBe(0);
  });

  it('runs the time of day from the power line and latches it on reading hours', () => {
    const c = cia();
    c.write(14, 0x80); // 50 Hz
    c.write(11, 0x01); c.write(10, 0x59); c.write(9, 0x59); c.write(8, 0x09);
    for (let i = 0; i < 5; i++) c.todTick(50);
    expect(c.read(11)).toBe(0x02);
    expect(c.read(10)).toBe(0x00);
    expect(c.read(9)).toBe(0x00);
    expect(c.read(8)).toBe(0x00);
  });
});
