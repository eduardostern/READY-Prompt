import { describe, expect, it } from 'vitest';
import { Sid } from '../src/c64/sid';

const PAL = 985248;

/** Frequency of a signal from its rising zero crossings. */
function pitch(s: Float32Array, rate: number): number {
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  let first = -1, last = -1, n = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i - 1] - mean < 0 && s[i] - mean >= 0) { if (first < 0) first = i; last = i; n++; }
  }
  return ((n - 1) * rate) / (last - first);
}

describe('SID', () => {
  it('plays A4 at 440 Hz from register value 7493 on a PAL clock', () => {
    const sid = new Sid(PAL);
    sid.write(0, 7493 & 0xff); sid.write(1, 7493 >> 8);
    sid.write(5, 0x00); sid.write(6, 0xf0); // sustain full
    sid.write(24, 0x0f);
    sid.write(4, 0x11); // triangle, gate
    sid.advanceTo(PAL); // one second
    const s = sid.takeSamples();
    expect(s.length).toBeGreaterThan(44000);
    expect(pitch(s.subarray(4410), 44100)).toBeCloseTo(440, 0);
  });

  it('attacks in 2 ms at rate 0 and decays to the sustain level', () => {
    const sid = new Sid(PAL);
    sid.write(19, 0x00); sid.write(20, 0x80); // voice 3: attack 0, decay 0, sustain 8
    sid.write(18, 0x21);
    sid.advanceTo(9 * 254);
    expect(sid.read(0x1c)).toBe(254);
    sid.advanceTo(9 * 255 + 1);
    expect(sid.read(0x1c)).toBe(255);
    sid.advanceTo(PAL / 10);
    expect(sid.read(0x1c)).toBe(0x88);
    sid.write(18, 0x20); // gate off: release
    sid.advanceTo(PAL);
    expect(sid.read(0x1c)).toBe(0);
  });

  it('reads voice 3 through OSC3 (the random numbers of so many games)', () => {
    const sid = new Sid(PAL);
    sid.write(14, 0xff); sid.write(15, 0xff);
    sid.write(18, 0x80); // noise
    const seen = new Set<number>();
    for (let i = 1; i <= 200; i++) { sid.advanceTo(i * 50); seen.add(sid.read(0x1b)); }
    expect(seen.size).toBeGreaterThan(100);
  });

  it('wraps the rate counter when the rate is lowered mid-count (the ADSR bug)', () => {
    const sid = new Sid(PAL);
    sid.write(19, 0xf0); // attack 15: a step every 31251 cycles
    sid.write(20, 0xf0); // sustain full, so the level stays once up
    sid.write(18, 0x21);
    sid.advanceTo(10000);
    sid.write(19, 0x00); // now 9: the counter is past it, and must wrap round 32768
    sid.advanceTo(10000 + 22000);
    expect(sid.read(0x1c)).toBe(0);
    sid.advanceTo(10000 + 32768);
    expect(sid.read(0x1c)).toBeGreaterThan(0);
  });
});
