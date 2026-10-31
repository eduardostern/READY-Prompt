/**
 * The PLA (82S100): which chip answers each address. The equations are the
 * ones read from a real C64's PLA (docs/pla.txt, Mäkelä and Smith),
 * evaluated as written for every combination at start-up into tables.
 *
 * Signal names follow that file: `LORAM` is the level of the _LORAM pin
 * (the 6510 port bit), `GAME`/`EXROM` the levels of the cartridge lines
 * (1 = no cartridge pulling them low).
 */

export const RAM = 0, BASIC = 1, KERNAL = 2, CHAROM = 3, IO = 4, ROML = 5, ROMH = 6, NONE = 7;
export const CHIP_NAMES = ['RAM', 'BASIC', 'KERNAL', 'CHAROM', 'IO', 'ROML', 'ROMH', 'NONE'];

interface CpuLines {
  LORAM: boolean; HIRAM: boolean; CHAREN: boolean; GAME: boolean; EXROM: boolean;
  A15: boolean; A14: boolean; A13: boolean; A12: boolean; RW: boolean; BA: boolean;
}

/** The equations, with _AEC = 0 (the CPU has the bus). Returns the chip selected. */
function cpuSide(l: CpuLines): number {
  const { LORAM, HIRAM, CHAREN, GAME, EXROM, A15, A14, A13, A12, RW, BA } = l;
  const AEC = false;
  const romh =
    (HIRAM && A15 && !A14 && A13 && !AEC && RW && !EXROM && !GAME) ||
    (A15 && A14 && A13 && !AEC && EXROM && !GAME);
  const roml =
    (LORAM && HIRAM && A15 && !A14 && !A13 && !AEC && RW && !EXROM) ||
    (A15 && !A14 && !A13 && !AEC && EXROM && !GAME);
  const ioArea = A15 && A14 && !A13 && A12 && !AEC;
  const io = ioArea && (
    (HIRAM && CHAREN && BA && RW && GAME) ||
    (HIRAM && CHAREN && !RW && GAME) ||
    (LORAM && CHAREN && BA && RW && GAME) ||
    (LORAM && CHAREN && !RW && GAME) ||
    (HIRAM && CHAREN && BA && RW && !EXROM && !GAME) ||
    (HIRAM && CHAREN && !RW && !EXROM && !GAME) ||
    (LORAM && CHAREN && BA && RW && !EXROM && !GAME) ||
    (LORAM && CHAREN && !RW && !EXROM && !GAME) ||
    (BA && RW && EXROM && !GAME) ||
    (!RW && EXROM && !GAME));
  const charom = ioArea && RW && (
    (HIRAM && !CHAREN && GAME) ||
    (LORAM && !CHAREN && GAME) ||
    (HIRAM && !CHAREN && !EXROM && !GAME));
  const kernal =
    (HIRAM && A15 && A14 && A13 && !AEC && RW && GAME) ||
    (HIRAM && A15 && A14 && A13 && !AEC && RW && !EXROM && !GAME);
  const basic = LORAM && HIRAM && A15 && !A14 && A13 && !AEC && RW && GAME;
  // CASRAM's last terms: in Ultimax mode RAM is off at 1000h-7FFFh, A000h-CFFFh.
  const ultimaxHole = EXROM && !GAME && (
    (!A15 && !A14 && A12) || (!A15 && !A14 && A13) || (!A15 && A14) ||
    (A15 && !A14 && A13) || (A15 && A14 && !A13 && !A12));
  if (romh) return ROMH;
  if (roml) return ROML;
  if (io) return IO;
  if (charom) return CHAROM;
  if (kernal) return KERNAL;
  if (basic) return BASIC;
  if (ultimaxHole) return NONE;
  return RAM;
}

/**
 * `cpuMap[mode * 32 + page * 2 + write]`: mode = LORAM | HIRAM<<1 |
 * CHAREN<<2 | GAME<<3 | EXROM<<4 (the 6510 port's bits 0-2, then the
 * cartridge lines), page = address >> 12.
 */
export const cpuMap = new Uint8Array(32 * 16 * 2);
for (let mode = 0; mode < 32; mode++) {
  for (let page = 0; page < 16; page++) {
    for (let w = 0; w < 2; w++) {
      cpuMap[mode * 32 + page * 2 + w] = cpuSide({
        LORAM: !!(mode & 1), HIRAM: !!(mode & 2), CHAREN: !!(mode & 4),
        GAME: !!(mode & 8), EXROM: !!(mode & 16),
        A15: !!(page & 8), A14: !!(page & 4), A13: !!(page & 2), A12: !!(page & 1),
        RW: !w, BA: true,
      });
    }
  }
}

/**
 * The VIC's side (_AEC = 1): CHAROM for VA13 = 0, VA12 = 1 when _VA14 is
 * high (banks 0 and 2), ROMH for VA13 = VA12 = 1 in Ultimax mode.
 * `vicMap[game*2+exrom][va14n*4 + va13*2 + va12]`.
 */
export function vicChip(GAME: boolean, EXROM: boolean, VA14n: boolean, VA13: boolean, VA12: boolean): number {
  const AEC = true;
  if (AEC && EXROM && !GAME && VA13 && VA12) return ROMH;
  if ((VA14n && AEC && GAME && !VA13 && VA12) || (VA14n && AEC && !EXROM && !GAME && !VA13 && VA12)) return CHAROM;
  return RAM;
}
