/**
 * A small two-pass 6502 assembler, for the tests, the built-in programs
 * and the AI board. Opcodes come from the CPU's own table, so every
 * mnemonic it runs (undocumented ones too) assembles.
 *
 *   label:  LDA #$01        ; comment
 *           STA (ptr),Y
 *   name = $C000            ; constants
 *   * = $0801               ; origin (also .org)
 *   .byte 1, $02, "TEXT"    ; bytes and strings (ASCII as written)
 *   .word label, $1234
 *   .fill 10, $EA
 *   .text "hello"           ; PETSCII: letters as the C64 prints them
 *
 * Expressions: decimal, $hex, %binary, 'c', labels, `*` (here), + - * / & |
 * ^ << >>, parentheses as `[ ]`, and `<x` / `>x` for the low and high byte.
 */
import { MNEMONIC, MODE_NAME } from '../cpu6510';

/** Opcode for each "MNEMONIC mode", the documented one where there are several. */
const OPCODES = new Map<string, number>();
for (let op = 0; op < 256; op++) {
  const key = `${MNEMONIC[op]} ${MODE_NAME[op]}`;
  if (!OPCODES.has(key)) OPCODES.set(key, op);
}
OPCODES.set('NOP imp', 0xea);
OPCODES.set('SBC imm', 0xe9);
const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

export interface Assembled {
  /** Lowest address written. */
  origin: number;
  /** The bytes from `origin` to the highest address written. */
  bytes: Uint8Array;
  symbols: Map<string, number>;
}

export class AsmError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

export function assemble(source: string, defines: Record<string, number> = {}): Assembled {
  const lines = source.split('\n');
  const symbols = new Map<string, number>(Object.entries(defines));
  // Per line: was the operand known to fit in zero page in pass 1?
  const zeroPage = new Map<number, boolean>();
  let out = new Map<number, number>();

  for (let pass = 1; pass <= 2; pass++) {
    let pc = 0;
    out = new Map();
    const emit = (b: number) => { out.set(pc, b & 0xff); pc = (pc + 1) & 0xffff; };

    for (let n = 0; n < lines.length; n++) {
      const lineNo = n + 1;
      let line = stripComment(lines[n]);
      if (!line.trim()) continue;
      const evaluate = (e: string, mustKnow: boolean) => {
        const v = evalExpr(e, symbols, pc, lineNo);
        if (v === undefined && (mustKnow || pass === 2)) throw new AsmError(`unknown symbol in "${e.trim()}"`, lineNo);
        return v;
      };

      // Constant: name = value (or * = origin).
      const eq = /^\s*([A-Za-z_.][\w.]*|\*)\s*=\s*(.+)$/.exec(line);
      if (eq) {
        const v = evaluate(eq[2], eq[1] === '*');
        if (eq[1] === '*') pc = v!;
        else if (v !== undefined) symbols.set(eq[1], v);
        continue;
      }
      // Label.
      const lab = /^\s*([A-Za-z_.][\w.]*):/.exec(line) ?? (/^([A-Za-z_][\w.]*)(\s|$)/.exec(line) && !isMnemonic(line.trim().split(/\s+/)[0]) ? /^([A-Za-z_][\w.]*)/.exec(line) : null);
      if (lab) {
        const name = lab[1];
        if (pass === 1 && symbols.has(name) && !(name in defines)) throw new AsmError(`"${name}" defined twice`, lineNo);
        symbols.set(name, pc);
        line = line.slice(lab[0].length);
        if (line.startsWith(':')) line = line.slice(1);
        if (!line.trim()) continue;
      }
      const m = /^\s*(\.?[A-Za-z]+)\s*(.*)$/.exec(line);
      if (!m) throw new AsmError(`cannot read "${line.trim()}"`, lineNo);
      const word = m[1].toUpperCase();
      const arg = m[2].trim();

      if (word.startsWith('.')) {
        switch (word) {
          case '.ORG': pc = evaluate(arg, true)!; break;
          case '.BYTE': case '.DB':
            for (const item of splitArgs(arg)) {
              if (/^".*"$/.test(item)) for (const ch of item.slice(1, -1)) emit(ch.charCodeAt(0));
              else emit(evaluate(item, false) ?? 0);
            }
            break;
          case '.TEXT':
            for (const item of splitArgs(arg)) {
              if (/^".*"$/.test(item)) for (const ch of item.slice(1, -1)) emit(petscii(ch));
              else emit(evaluate(item, false) ?? 0);
            }
            break;
          case '.WORD': case '.DW':
            for (const item of splitArgs(arg)) { const v = evaluate(item, false) ?? 0; emit(v); emit(v >> 8); }
            break;
          case '.FILL': {
            const [count, value] = splitArgs(arg);
            const c = evaluate(count, true)!;
            const v = value ? evaluate(value, false) ?? 0 : 0;
            for (let i = 0; i < c; i++) emit(v);
            break;
          }
          default: throw new AsmError(`unknown directive ${word}`, lineNo);
        }
        continue;
      }

      if (!isMnemonic(word)) throw new AsmError(`unknown instruction ${word}`, lineNo);
      const [mode, expr] = parseOperand(word, arg);
      const op = (name: string) => {
        const o = OPCODES.get(`${word} ${name}`);
        if (o === undefined) throw new AsmError(`${word} has no ${name} mode`, lineNo);
        return o;
      };
      if (mode === 'imp' || mode === 'acc') {
        emit(OPCODES.get(`${word} ${mode}`) ?? OPCODES.get(`${word} ${mode === 'acc' ? 'imp' : 'acc'}`) ?? op(mode));
        continue;
      }
      const v = evaluate(expr, false);
      if (BRANCHES.has(word)) {
        emit(op('rel'));
        const off = v === undefined ? 0 : v - ((pc + 1) & 0xffff);
        if (pass === 2 && (off < -128 || off > 127)) throw new AsmError(`branch out of range (${off})`, lineNo);
        emit(off);
        continue;
      }
      if (mode === 'imm') { emit(op('imm')); emit(v ?? 0); continue; }
      if (mode === 'izx' || mode === 'izy') { emit(op(mode)); emit(v ?? 0); continue; }
      if (mode === 'ind') { emit(op('ind')); emit(v ?? 0); emit((v ?? 0) >> 8); continue; }
      // zp / abs, plain or indexed: zero page if known small in pass 1 and the mode exists.
      if (pass === 1) zeroPage.set(n, v !== undefined && v < 0x100);
      const suffix = mode === 'x' ? 'x' : mode === 'y' ? 'y' : '';
      const zpName = suffix ? `zp${suffix}` : 'zp';
      const absName = suffix ? `ab${suffix}` : 'abs';
      if (zeroPage.get(n) && OPCODES.has(`${word} ${zpName}`)) { emit(op(zpName)); emit(v ?? 0); }
      else { emit(op(absName)); emit(v ?? 0); emit((v ?? 0) >> 8); }
    }
  }

  if (!out.size) return { origin: 0, bytes: new Uint8Array(0), symbols };
  const addrs = [...out.keys()];
  const origin = Math.min(...addrs);
  const end = Math.max(...addrs);
  const bytes = new Uint8Array(end - origin + 1);
  for (const [a, b] of out) bytes[a - origin] = b;
  return { origin, bytes, symbols };
}

/** A .prg: load address, then the bytes. */
export function toPrg(a: Assembled): Uint8Array {
  const p = new Uint8Array(a.bytes.length + 2);
  p[0] = a.origin & 0xff; p[1] = a.origin >> 8;
  p.set(a.bytes, 2);
  return p;
}

function isMnemonic(w: string): boolean {
  return MNEMONIC.includes(w.toUpperCase());
}

function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (c === "'" && !inStr && line[i + 2] === "'") i += 2;
    else if (c === ';' && !inStr) return line.slice(0, i);
  }
  return line;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '', inStr = false;
  for (const c of s) {
    if (c === '"') inStr = !inStr;
    if (c === ',' && !inStr) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

type Operand = ['imp' | 'acc' | 'imm' | 'izx' | 'izy' | 'ind' | 'x' | 'y' | 'plain', string];

function parseOperand(word: string, arg: string): Operand {
  if (!arg) return [OPCODES.has(`${word} acc`) ? 'acc' : 'imp', ''];
  if (/^A$/i.test(arg)) return ['acc', ''];
  if (arg.startsWith('#')) return ['imm', arg.slice(1)];
  let m = /^\((.+),\s*X\)$/i.exec(arg);
  if (m) return ['izx', m[1]];
  m = /^\((.+)\)\s*,\s*Y$/i.exec(arg);
  if (m) return ['izy', m[1]];
  m = /^\((.+)\)$/.exec(arg);
  if (m && word === 'JMP') return ['ind', m[1]];
  m = /^(.+),\s*([XY])$/i.exec(arg);
  if (m) return [m[2].toUpperCase() === 'X' ? 'x' : 'y', m[1]];
  return ['plain', arg];
}

/** PETSCII for .text: letters print as capitals on the C64's default set. */
function petscii(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x61 && c <= 0x7a) return c - 0x20;
  if (c >= 0x41 && c <= 0x5a) return c + 0x80;
  return c;
}

function evalExpr(src: string, symbols: Map<string, number>, here: number, line: number): number | undefined {
  const tokens = src.match(/\$[0-9a-fA-F]+|%[01]+|\d+|'.'|[A-Za-z_.][\w.]*|<<|>>|[-+*/&|^<>\[\]()~]/g) ?? [];
  let i = 0;
  let unknown = false;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): number => {
    const t = next();
    if (t === undefined) throw new AsmError(`incomplete expression "${src.trim()}"`, line);
    if (t === '[' || t === '(') { const v = binary(0); next(); return v; }
    if (t === '-') return -primary();
    if (t === '~') return ~primary() & 0xffff;
    if (t === '<') return primary() & 0xff;
    if (t === '>') return (primary() >> 8) & 0xff;
    if (t === '*') return here;
    if (t[0] === '$') return parseInt(t.slice(1), 16);
    if (t[0] === '%') return parseInt(t.slice(1), 2);
    if (t[0] === "'") return t.charCodeAt(1);
    if (/^\d/.test(t)) return parseInt(t, 10);
    const v = symbols.get(t);
    if (v === undefined) { unknown = true; return 0; }
    return v;
  };
  const PREC: Record<string, number> = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6 };
  const binary = (min: number): number => {
    let left = primary();
    for (;;) {
      const op = peek();
      const p = op !== undefined ? PREC[op] : undefined;
      if (p === undefined || p <= min) return left;
      next();
      const right = binary(p);
      switch (op) {
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        case '/': left = Math.trunc(left / right); break;
        case '&': left &= right; break;
        case '|': left |= right; break;
        case '^': left ^= right; break;
        case '<<': left <<= right; break;
        case '>>': left >>= right; break;
      }
    }
  };
  const v = binary(0);
  if (i < tokens.length) throw new AsmError(`cannot read "${src.trim()}"`, line);
  return unknown ? undefined : v & 0xffff;
}
