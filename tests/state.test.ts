import { describe, expect, it } from 'vitest';
import { loadState, Rewind, saveState } from '../src/c64/state';
import { boot } from './helpers';

const PROGRAM = '10 POKE 53280,RND(1)*16:POKE 54296,15:POKE 54277,9:POKE 54276,17:POKE 54273,RND(1)*60:PRINT RND(1);:GOTO 10\nRUN\n';

describe('save states', () => {
  it('goes on exactly as the machine would have: same picture, sound and cycles', () => {
    const c = boot();
    c.type(PROGRAM);
    c.run(20);
    const state = saveState(c);
    c.run(30);
    const frame = c.vic.frame.slice();
    const cycles = c.cycles;
    c.takeAudio();
    c.run(5);
    const sound = c.takeAudio();

    const d = boot();
    loadState(d, state);
    d.run(30);
    expect(d.cycles).toBe(cycles);
    expect(d.vic.frame).toEqual(frame);
    d.takeAudio();
    d.run(5);
    expect(d.takeAudio()).toEqual(sound);
  });

  it('is small: the RAM deflates', () => {
    const c = boot();
    expect(saveState(c).length).toBeLessThan(40_000);
  });

  it('rewinds a second at a time', () => {
    const c = boot();
    const r = new Rewind(50, 30);
    c.type('10 PRINT "A";:GOTO 10\nRUN\n');
    for (let i = 0; i < 200; i++) { c.runFrame(); r.tick(c); }
    const at = c.cycles;
    expect(r.back(c)).toBe(true);
    expect(c.cycles).toBeLessThan(at);
    expect(at - c.cycles).toBeLessThanOrEqual(2 * 50 * 19656);
  });
});
