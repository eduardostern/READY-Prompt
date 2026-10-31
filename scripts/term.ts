/**
 * Builds TERM (programs/TERM.asm) into a .prg, with the
 * tables it needs written in at ;@TABLES: the screen's line addresses,
 * ASCII and CP437 to screen codes of the lower-case set, and the
 * keyboard's PETSCII to ASCII. `npm run term` writes src/programs/TERM.prg
 * (commit it with the source).
 */
import { readFileSync } from 'node:fs';
import { assemble, toPrg } from '../src/c64/as65';

/** Screen codes in the lower-case set: a-z are 01h-1Ah, A-Z 41h-5Ah. */
function screenCode(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x61 && c <= 0x7a) return c - 0x60;
  if (c >= 0x41 && c <= 0x5a) return c;
  if (c >= 0x20 && c <= 0x3f) return c;
  return 0x3f; // ?
}

const ASCII: Record<number, number> = {
  0x40: 0x00, 0x5b: 0x1b, 0x5c: 0x1c, 0x5d: 0x1d, 0x5e: 0x1e, 0x5f: 0x64, 0x60: 0x27,
  0x7b: 0x28, 0x7c: 0x5d, 0x7d: 0x29, 0x7e: 0x2d,
};
const asctab = Array.from({ length: 0x60 }, (_, i) => {
  const c = 0x20 + i;
  return ASCII[c] ?? (c === 0x7f ? 0x20 : screenCode(String.fromCharCode(c)));
});

// CP437 80h-FFh: letters by their plain look, box drawing and blocks as the C64's graphics.
const LETTERS = 'CueaaaaceeeiiiAAEaAooouuyOUcLYPfaiounNao?--??!<>';
const GRAPHICS: number[] = [
  0x66, 0x66, 0x66, 0x5d, 0x73, 0x73, 0x73, 0x6e, 0x6e, 0x73, 0x5d, 0x6e, 0x7d, 0x7d, 0x7d, 0x6e, // B0-BF
  0x6d, 0x71, 0x72, 0x6b, 0x40, 0x5b, 0x6b, 0x6b, 0x6d, 0x70, 0x71, 0x72, 0x6b, 0x40, 0x5b, 0x71, // C0-CF
  0x71, 0x72, 0x72, 0x6d, 0x6d, 0x70, 0x70, 0x5b, 0x5b, 0x7d, 0x70, 0xa0, 0x62, 0x61, 0xe1, 0xe2, // D0-DF
];
const GREEK = 'asGpSsutOOOd8oen';
const SYMBOLS = '=+><()/-o..vn2* ';
const cp437 = Array.from({ length: 128 }, (_, i) => {
  if (i < 0x30) {
    const ch = LETTERS[i];
    return ch === 'L' && i === 0x1c ? 0x1c : screenCode(ch); // 9Ch is the pound sign
  }
  if (i < 0x60) return GRAPHICS[i - 0x30];
  if (i < 0x70) return screenCode(GREEK[i - 0x60]);
  return screenCode(SYMBOLS[i - 0x70]);
});

// Keys (PETSCII from GETIN, lower-case set) to ASCII; 0 sends nothing.
const keytab = new Array(256).fill(0);
keytab[0x0d] = 13;
keytab[0x14] = 8; // DEL: backspace
for (let c = 0x20; c <= 0x40; c++) keytab[c] = c;
for (let c = 0x41; c <= 0x5a; c++) keytab[c] = c + 0x20; // unshifted letters: lower case
for (let c = 0xc1; c <= 0xda; c++) keytab[c] = c - 0x80; // shifted: capitals
Object.assign(keytab, { 0x5b: 0x5b, 0x5c: 0x5c, 0x5d: 0x5d, 0x5e: 0x5e, 0x5f: 0x5f, 0xa9: 0x7c, 0xff: 0x7e, 0xdd: 0x7c, 0xdb: 0x2b });
for (let c = 1; c <= 26; c++) if (![0x0d, 0x11, 0x12, 0x13, 0x14].includes(c)) keytab[c] = c; // CTRL + letter

const rows = Array.from({ length: 25 }, (_, r) => 0x0400 + r * 40);
const bytes = (name: string, list: number[]) => {
  const lines = [`${name}:`];
  for (let i = 0; i < list.length; i += 16) lines.push(`        .byte ${list.slice(i, i + 16).map(b => `$${b.toString(16).padStart(2, '0')}`).join(', ')}`);
  return lines.join('\n');
};
const tables = [
  bytes('rowlo', rows.map(a => a & 0xff)),
  bytes('rowhi', rows.map(a => a >> 8)),
  bytes('asctab', asctab),
  bytes('cp437', cp437),
  bytes('keytab', keytab),
].join('\n');

export function buildTerm(): Uint8Array {
  const src = readFileSync(new URL('../programs/TERM.asm', import.meta.url), 'utf8').replace(/^;@TABLES$/m, tables);
  return toPrg(assemble(src));
}
