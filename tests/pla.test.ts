import { describe, expect, it } from 'vitest';
import { CHIP_NAMES, cpuMap } from '../src/c64/pla';

/** The chip at pages 8, A, D, E for a mode (reads). */
function map(lo: number, hi: number, ch: number, game: number, exrom: number): string {
  const mode = lo | (hi << 1) | (ch << 2) | (game << 3) | (exrom << 4);
  return [0x0, 0x1, 0x8, 0xa, 0xc, 0xd, 0xe].map(p => CHIP_NAMES[cpuMap[mode * 32 + p * 2]]).join(' ');
}

describe('PLA from the 82S100 equations', () => {
  it('gives the usual memory map with no cartridge', () => {
    expect(map(1, 1, 1, 1, 1)).toBe('RAM RAM RAM BASIC RAM IO KERNAL');
    expect(map(0, 1, 1, 1, 1)).toBe('RAM RAM RAM RAM RAM IO KERNAL');
    expect(map(1, 0, 1, 1, 1)).toBe('RAM RAM RAM RAM RAM IO RAM');
    expect(map(0, 0, 1, 1, 1)).toBe('RAM RAM RAM RAM RAM RAM RAM');
    expect(map(1, 1, 0, 1, 1)).toBe('RAM RAM RAM BASIC RAM CHAROM KERNAL');
    expect(map(0, 1, 0, 1, 1)).toBe('RAM RAM RAM RAM RAM CHAROM KERNAL');
    expect(map(1, 0, 0, 1, 1)).toBe('RAM RAM RAM RAM RAM CHAROM RAM');
    expect(map(0, 0, 0, 1, 1)).toBe('RAM RAM RAM RAM RAM RAM RAM');
  });

  it('maps 8K, 16K and Ultimax cartridges', () => {
    expect(map(1, 1, 1, 1, 0)).toBe('RAM RAM ROML BASIC RAM IO KERNAL');
    expect(map(1, 1, 1, 0, 0)).toBe('RAM RAM ROML ROMH RAM IO KERNAL');
    expect(map(1, 1, 1, 0, 1)).toBe('RAM NONE ROML NONE NONE IO ROMH');
    // Ultimax ignores the port: ROML, I/O and ROMH whatever it says.
    expect(map(0, 0, 0, 0, 1)).toBe('RAM NONE ROML NONE NONE IO ROMH');
  });

  it('sends writes under ROM to RAM, and Ultimax writes at 8000h to the cartridge', () => {
    const w = (mode: number, page: number) => CHIP_NAMES[cpuMap[mode * 32 + page * 2 + 1]];
    expect(w(31, 0xa)).toBe('RAM');
    expect(w(31, 0xe)).toBe('RAM');
    expect(w(31, 0xd)).toBe('IO');
    expect(w(0b10111, 0x8)).toBe('ROML');
  });
});
