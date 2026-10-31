import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/c64/basic';
import { D64, petsciiName } from '../src/c64/disk';
import { boot, runUntil } from './helpers';

function diskWith(files: [string, Uint8Array][]): D64 {
  const d = D64.blank('TEST DISK', 'T1');
  for (const [n, data] of files) d.write(petsciiName(n), 2, data);
  return d;
}

describe('disks', () => {
  it('writes and reads files across sectors, and counts blocks as the 1541 does', () => {
    const d = D64.blank();
    expect(d.blocksFree).toBe(664);
    const big = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    d.write(petsciiName('BIG'), 2, big);
    const e = d.find(petsciiName('BIG'))!;
    expect(e.blocks).toBe(4);
    expect(e.track).toBe(17);
    expect([...d.read(e)]).toEqual([...big]);
    expect(d.blocksFree).toBe(660);
    d.scratch(e);
    expect(d.blocksFree).toBe(664);
    expect(d.find(petsciiName('BIG'))).toBeNull();
  });

  it('LOADs the directory with LOAD"$",8 and LISTs it', () => {
    const c = boot();
    c.drives[0].insert(diskWith([['HELLO', tokenize('10 PRINT "HI"')], ['GAME', new Uint8Array(600)]]));
    c.type('LOAD"$",8\nLIST\n');
    const screen = runUntil(c, 'BLOCKS FREE.', 200);
    expect(screen).toContain('0 "TEST DISK       " T1 2A');
    expect(screen).toContain('1    "HELLO"            PRG');
    expect(screen).toContain('3    "GAME"             PRG');
    expect(screen).toContain('660 BLOCKS FREE.');
  });

  it('LOADs a program by name (with a wildcard) and RUNs it', () => {
    const c = boot();
    c.drives[0].insert(diskWith([['HELLO WORLD', tokenize('10 PRINT "FROM DISK"')]]));
    c.type('LOAD"HEL*",8\nRUN\n');
    const s = runUntil(c, 'FROM DISK', 200);
    expect(s).toContain('SEARCHING FOR HEL*');
    expect(s).toContain('LOADING');
  });

  it('says FILE NOT FOUND, and DEVICE NOT PRESENT for drive 9 with no disk', () => {
    const c = boot();
    c.drives[0].insert(D64.blank());
    c.type('LOAD"NOPE",8\n');
    runUntil(c, '?FILE NOT FOUND  ERROR', 200);
    c.type('LOAD"X",9\n');
    runUntil(c, '?DEVICE NOT PRESENT  ERROR', 200);
  });

  it('SAVEs, writes a sequential file, reads it back and reports through channel 15', () => {
    const c = boot();
    c.drives[0].insert(D64.blank());
    c.type('10 PRINT "SAVED"\nSAVE"PROG",8\n');
    runUntil(c, 'READY.', 100);
    c.run(30);
    expect(c.drives[0].disk!.find(petsciiName('PROG'))).not.toBeNull();
    c.type('NEW\n10 OPEN 2,8,2,"DATA,S,W":PRINT#2,"ONE":PRINT#2,"TWO":CLOSE 2\n');
    c.type('20 OPEN 2,8,2,"DATA,S,R":INPUT#2,A$,B$:CLOSE 2:PRINT A$;"+";B$\n');
    c.type('30 OPEN 15,8,15:INPUT#15,E,E$:PRINT E;E$:CLOSE 15\nRUN\n');
    const s = runUntil(c, 'ONE+TWO', 300);
    runUntil(c, ' 0 OK', 100);
    void s;
    c.type('SAVE"PROG",8\n');
    c.run(60);
    c.type('NEW\n10 OPEN 15,8,15:INPUT#15,E,E$:PRINT E;E$:CLOSE 15\nRUN\n');
    runUntil(c, ' 63 FILE EXISTS', 200);
  });

  it('scratches and renames through channel 15', () => {
    const c = boot();
    const d = diskWith([['ONE', new Uint8Array(10)], ['TWO', new Uint8Array(10)]]);
    c.drives[0].insert(d);
    c.type('OPEN 15,8,15,"S:ONE":CLOSE 15\nOPEN 15,8,15,"R:THREE=TWO":CLOSE 15\n');
    c.run(80);
    expect(d.find(petsciiName('ONE'))).toBeNull();
    expect(d.find(petsciiName('THREE'))).not.toBeNull();
  });
});
