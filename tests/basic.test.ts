import { describe, expect, it } from 'vitest';
import { detokenize, tokenize } from '../src/c64/basic';
import { injectPrg } from '../src/c64/prg';
import { boot, runUntil } from './helpers';

describe('BASIC listings', () => {
  it('crunches keywords as the C64 editor does', () => {
    const prg = tokenize('10 PRINT "HI":GOTO 10\n20 rem print stays as typed\n30 data print,1:print');
    expect(prg[0]).toBe(0x01);
    expect(prg[1]).toBe(0x08);
    const text = detokenize(prg.subarray(2));
    expect(text).toBe('10 PRINT "HI":GOTO 10\n20 REM PRINT STAYS AS TYPED\n30 DATA PRINT,1:PRINT');
    // REM and DATA keep "PRINT" as letters; after DATA's colon it is a token again.
    const bytes = [...prg];
    expect(bytes.filter(b => b === 0x99).length).toBe(2);
  });

  it('takes the first keyword in token order, like the real editor (FORMAT = FOR MAT)', () => {
    const prg = tokenize('10 FORMAT=1');
    expect([...prg.subarray(6, 10)]).toEqual([0x81, 0x4d, 0x41, 0x54]);
  });

  it('turns magazine control codes into PETSCII', () => {
    const prg = tokenize('10 PRINT "{CLR}{3 DOWN}{RED}X{RVS ON}"');
    expect([...prg.subarray(9, 17)]).toEqual([0x93, 0x11, 0x11, 0x11, 0x1c, 0x58, 0x12, 0x22]);
  });

  it('loads a program into memory and RUNs it', () => {
    const c = boot();
    const prg = tokenize('10 FOR I=1 TO 3\n20 PRINT "LINE";I\n30 NEXT');
    const r = injectPrg(c, prg);
    expect(r.basic).toBe(true);
    c.type('LIST\nRUN\n');
    const screen = runUntil(c, 'LINE 3');
    expect(screen).toContain('20 PRINT "LINE";I');
  });

  it('waits for BASIC to be ready before dropping a program in', () => {
    const c = boot('pal', 1);
    c.whenReady(() => { injectPrg(c, tokenize('10 PRINT "LATE"')); c.type('RUN\n'); });
    runUntil(c, 'LATE', 400);
  });
});
