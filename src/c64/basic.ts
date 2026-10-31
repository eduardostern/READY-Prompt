/**
 * BASIC V2 listings to programs and back.
 *
 * `tokenize` crunches a listing the way the C64's editor does: at each
 * place outside quotes it tries the keywords in token order and takes the
 * first that matches (so FORMAT is FOR + MAT, as on the real machine);
 * after REM the line is kept as typed, after DATA until the next colon.
 * Magazine control codes in braces ({CLR}, {DOWN}, {RED}, {RVS ON}...)
 * become their PETSCII bytes.
 */

export const KEYWORDS = [
  'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO', 'RUN', 'IF', 'RESTORE', 'GOSUB',
  'RETURN', 'REM', 'STOP', 'ON', 'WAIT', 'LOAD', 'SAVE', 'VERIFY', 'DEF', 'POKE', 'PRINT#', 'PRINT', 'CONT', 'LIST',
  'CLR', 'CMD', 'SYS', 'OPEN', 'CLOSE', 'GET', 'NEW', 'TAB(', 'TO', 'FN', 'SPC(', 'THEN', 'NOT', 'STEP', '+', '-',
  '*', '/', '^', 'AND', 'OR', '>', '=', '<', 'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP',
  'COS', 'SIN', 'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'GO',
];
const TOKEN_REM = 0x8f;
const TOKEN_DATA = 0x83;

/** Control codes as magazines printed them. */
const CODES: Record<string, number> = {
  CLR: 0x93, CLEAR: 0x93, HOME: 0x13, DOWN: 0x11, UP: 0x91, LEFT: 0x9d, RIGHT: 0x1d, 'CRSR DOWN': 0x11,
  'CRSR UP': 0x91, 'CRSR LEFT': 0x9d, 'CRSR RIGHT': 0x1d, 'RVS ON': 0x12, 'RVS OFF': 0x92, RVSON: 0x12,
  RVSOFF: 0x92, REVERSE: 0x12, DEL: 0x14, INST: 0x94, SPACE: 0x20, RETURN: 0x0d,
  BLK: 0x90, BLACK: 0x90, WHT: 0x05, WHITE: 0x05, RED: 0x1c, CYN: 0x9f, CYAN: 0x9f, PUR: 0x9c, PURPLE: 0x9c,
  GRN: 0x1e, GREEN: 0x1e, BLU: 0x1f, BLUE: 0x1f, YEL: 0x9e, YELLOW: 0x9e, ORNG: 0x81, ORANGE: 0x81, BRN: 0x95,
  BROWN: 0x95, LRED: 0x96, 'LT RED': 0x96, GRY1: 0x97, 'GRAY 1': 0x97, GRY2: 0x98, 'GRAY 2': 0x98,
  LGRN: 0x99, 'LT GREEN': 0x99, LBLU: 0x9a, 'LT BLUE': 0x9a, GRY3: 0x9b, 'GRAY 3': 0x9b,
  F1: 0x85, F3: 0x86, F5: 0x87, F7: 0x88, F2: 0x89, F4: 0x8a, F6: 0x8b, F8: 0x8c, PI: 0xff,
};

/** One character of a listing as PETSCII (letters plain, as typed unshifted). */
export function petscii(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x61 && c <= 0x7a) return c - 0x20;
  if (c === 0xa3) return 0x5c; // £
  if (ch === 'π') return 0xff;
  if (ch === '←' || ch === '_') return 0x5f;
  if (ch === '↑') return 0x5e;
  return c < 0x80 ? c : 0x3f;
}

export class ListingError extends Error {}

/** Crunches one line's text (after its number) into bytes. */
export function crunch(text: string): number[] {
  const out: number[] = [];
  let quote = false, data = false, rem = false;
  let i = 0;
  const upper = text.toUpperCase();
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const end = text.indexOf('}', i);
      if (end > i) {
        const inside = text.slice(i + 1, end).trim().toUpperCase();
        // {3 DOWN}, {DOWN*3}: repeated codes.
        let count = 1, name = inside;
        const before = /^(\d+)\s+(.+)$/.exec(inside);
        const after = /^(.+?)\s*\*\s*(\d+)$/.exec(inside);
        if (before) { count = Number(before[1]); name = before[2]; } else if (after) { count = Number(after[2]); name = after[1]; }
        const code = CODES[name] ?? (/^\$?[0-9A-F]{2}$/.test(name) ? parseInt(name.replace('$', ''), 16) : undefined);
        if (code === undefined) throw new ListingError(`unknown control code {${inside}}`);
        for (let k = 0; k < count; k++) out.push(code);
        i = end + 1;
        continue;
      }
    }
    if (ch === '"') { quote = !quote; out.push(0x22); i++; continue; }
    if (quote || rem) { out.push(petscii(ch)); i++; continue; }
    if (data) {
      if (ch === ':') data = false;
      out.push(petscii(ch)); i++; continue;
    }
    if (ch === '?') { out.push(0x99); i++; continue; } // ? is PRINT
    let matched = -1;
    for (let k = 0; k < KEYWORDS.length; k++) {
      if (upper.startsWith(KEYWORDS[k], i)) { matched = k; break; }
    }
    if (matched >= 0) {
      const token = 0x80 + matched;
      out.push(token);
      i += KEYWORDS[matched].length;
      if (token === TOKEN_REM) rem = true;
      if (token === TOKEN_DATA) data = true;
      continue;
    }
    if (ch === ' ' && out.length === 0) { i++; continue; } // the editor drops spaces after the number
    out.push(petscii(ch));
    i++;
  }
  return out;
}

/** A listing (numbered lines) to a program as LOAD puts it at 0801h: the .prg's bytes, load address first. */
export function tokenize(listing: string, start = 0x0801): Uint8Array {
  const lines = new Map<number, number[]>();
  for (const [n, raw] of listing.replace(/\r/g, '').split('\n').entries()) {
    if (!raw.trim()) continue;
    const m = /^\s*(\d+)\s?(.*)$/.exec(raw);
    if (!m) throw new ListingError(`line ${n + 1} has no line number: "${raw.trim().slice(0, 30)}"`);
    const num = Number(m[1]);
    if (num > 63999) throw new ListingError(`line number ${num} is over 63999`);
    try {
      lines.set(num, crunch(m[2]));
    } catch (e) {
      throw new ListingError(`line ${num}: ${(e as Error).message}`);
    }
  }
  if (!lines.size) throw new ListingError('no numbered lines');
  const out: number[] = [start & 0xff, start >> 8];
  let addr = start;
  for (const num of [...lines.keys()].sort((a, b) => a - b)) {
    const body = lines.get(num)!;
    if (body.length > 250) throw new ListingError(`line ${num} is too long for the C64 (80 characters on screen)`);
    const next = addr + 4 + body.length + 1;
    out.push(next & 0xff, next >> 8, num & 0xff, num >> 8, ...body, 0);
    addr = next;
  }
  out.push(0, 0);
  return Uint8Array.from(out);
}

/** A program in memory (or a .prg without its load address) back to text. */
export function detokenize(bytes: Uint8Array, start = 0x0801): string {
  const lines: string[] = [];
  let p = 0;
  while (p + 4 <= bytes.length) {
    const link = bytes[p] | (bytes[p + 1] << 8);
    if (link === 0) break;
    const num = bytes[p + 2] | (bytes[p + 3] << 8);
    p += 4;
    let s = `${num} `;
    let quote = false;
    while (p < bytes.length && bytes[p] !== 0) {
      const b = bytes[p++];
      if (b === 0x22) quote = !quote;
      if (b >= 0x80 && b <= 0xcb && !quote) s += KEYWORDS[b - 0x80];
      else if (b === 0xff) s += 'π';
      else if (b >= 0x20 && b < 0x80) s += String.fromCharCode(b === 0x5c ? 0xa3 : b);
      else s += `{${b.toString(16).padStart(2, '0')}}`;
    }
    p++;
    lines.push(s);
    if (link <= start) break;
    p = link - start;
  }
  return lines.join('\n');
}
