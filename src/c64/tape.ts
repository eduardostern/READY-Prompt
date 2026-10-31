/**
 * Cassettes: the pulse timeline the Datasette plays into CIA1's FLAG line,
 * and the files in the KERNAL's own format found on it.
 *
 * A .tap is the pulses as recorded (C64-TAPE-RAW: each byte a pulse of
 * n × 8 cycles; 0 means a long one, in version 1 with its length in the
 * next 3 bytes). A .t64 is files only: they are written onto a blank tape
 * the way the KERNAL's SAVE writes them, so both kinds play in real time
 * and both load at once through the LOAD trap.
 *
 * The KERNAL's format: every byte is a long-medium marker, 8 bits
 * (short-medium = 0, medium-short = 1, low bit first) and an odd parity
 * bit; a block ends with long-short. A file is a header block (type,
 * start, end, 16-character name) and a data block, each sent twice: first
 * after the countdown 89h..81h, then again after 09h..01h.
 */

/** Pulse lengths of the KERNAL's writer, in cycles (TAP bytes 30h, 42h, 56h). */
export const SHORT = 0x30 * 8, MEDIUM = 0x42 * 8, LONG = 0x56 * 8;

export interface TapeFile {
  /** Header type: 1 relocatable program, 3 program at its own address, 4 data file header. */
  type: number;
  name: string;
  /** Name as the 16 PETSCII bytes on tape. */
  rawName: Uint8Array;
  start: number;
  data: Uint8Array;
  /** Pulse index of the file's first leader pulse, and just after its last pulse. */
  pulseStart: number;
  pulseEnd: number;
}

export class TapeError extends Error {}

export class Tape {
  /** Pulse lengths in cycles. */
  pulses: number[];
  files: TapeFile[];
  /** The next pulse to play, and the cycles left of it. */
  pos = 0;
  left = 0;
  /** SAVE wrote on it since it was inserted. */
  dirty = false;

  constructor(pulses: number[], public name = 'tape') {
    this.pulses = pulses;
    this.files = decodeFiles(pulses);
    this.left = pulses[0] ?? 0;
  }

  static fromTap(data: Uint8Array, name = 'tape.tap'): Tape {
    const magic = String.fromCharCode(...data.subarray(0, 12));
    if (magic !== 'C64-TAPE-RAW') throw new TapeError('not a C64 .tap file');
    const version = data[12];
    const len = data[16] | (data[17] << 8) | (data[18] << 16) | (data[19] << 24);
    const end = Math.min(data.length, 20 + len);
    const pulses: number[] = [];
    for (let i = 20; i < end; i++) {
      const b = data[i];
      if (b) { pulses.push(b * 8); continue; }
      if (version >= 1 && i + 3 < end) {
        pulses.push(data[i + 1] | (data[i + 2] << 8) | (data[i + 3] << 16));
        i += 3;
      } else {
        pulses.push(256 * 8);
      }
    }
    return new Tape(pulses, name);
  }

  static fromT64(data: Uint8Array, name = 'tape.t64'): Tape {
    const sig = String.fromCharCode(...data.subarray(0, 3));
    if (sig !== 'C64' && !String.fromCharCode(...data.subarray(0, 32)).includes('T64')) throw new TapeError('not a .t64 file');
    const max = data[34] | (data[35] << 8);
    const used = Math.max(1, data[36] | (data[37] << 8));
    const entries: { start: number; end: number; offset: number; rawName: Uint8Array; fileType: number }[] = [];
    for (let i = 0; i < Math.max(max, used); i++) {
      const e = 64 + i * 32;
      if (e + 32 > data.length) break;
      if (data[e] !== 1) continue; // 1 = normal tape file
      entries.push({
        fileType: data[e + 1],
        start: data[e + 2] | (data[e + 3] << 8),
        end: data[e + 4] | (data[e + 5] << 8),
        offset: data[e + 8] | (data[e + 9] << 8) | (data[e + 10] << 16) | (data[e + 11] << 24),
        rawName: data.slice(e + 16, e + 32),
      });
    }
    if (!entries.length) throw new TapeError('no files in this .t64');
    // Many .t64 files give a wrong end address: trust the file's length instead.
    entries.sort((a, b) => a.offset - b.offset);
    const pulses: number[] = [];
    entries.forEach((e, n) => {
      const next = entries[n + 1]?.offset ?? data.length;
      let length = e.end - e.start;
      if (length <= 0 || e.offset + length > data.length || (e.end === 0xc3c6)) length = next - e.offset;
      const body = data.subarray(e.offset, e.offset + length);
      encodeFile(pulses, 1, e.start, body, padName(e.rawName));
    });
    return new Tape(pulses, name);
  }

  static blank(name = 'blank.tap'): Tape {
    return new Tape([], name);
  }

  /** The tape as a .tap file (version 1). */
  toTap(): Uint8Array {
    const body: number[] = [];
    for (const p of this.pulses) {
      const v = Math.round(p / 8);
      if (v >= 1 && v <= 255) body.push(v);
      else body.push(0, p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff);
    }
    const out = new Uint8Array(20 + body.length);
    out.set([...'C64-TAPE-RAW'].map(c => c.charCodeAt(0)));
    out[12] = 1;
    out[16] = body.length & 0xff; out[17] = (body.length >> 8) & 0xff;
    out[18] = (body.length >> 16) & 0xff; out[19] = (body.length >> 24) & 0xff;
    out.set(body, 20);
    return out;
  }

  rewind(): void { this.pos = 0; this.left = this.pulses[0] ?? 0; }

  /** Moves the tape to pulse `i`. */
  seek(i: number): void {
    this.pos = Math.min(i, this.pulses.length);
    this.left = this.pulses[this.pos] ?? 0;
  }

  get atEnd(): boolean { return this.pos >= this.pulses.length; }

  /** Where the tape is, 0..1. */
  get progress(): number { return this.pulses.length ? this.pos / this.pulses.length : 0; }

  /** Plays one cycle: true when a pulse ended (an edge for the FLAG line). */
  tick(): boolean {
    if (this.pos >= this.pulses.length) return false;
    if (--this.left > 0) return false;
    this.pos++;
    this.left = this.pulses[this.pos] ?? 0;
    return true;
  }

  /** The next file from where the tape is whose name matches (KERNAL wildcards * and ?). */
  findFile(name: Uint8Array): TapeFile | null {
    for (const f of this.files) {
      if (f.pulseEnd <= this.pos) continue; // already passed
      if (f.type === 5) continue; // end-of-tape marker
      if (nameMatches(name, f.rawName)) return f;
    }
    return null;
  }

  /** SAVE: the file goes onto the tape where it is, over whatever followed. */
  record(type: number, start: number, data: Uint8Array, rawName: Uint8Array): void {
    const tail: number[] = [];
    encodeFile(tail, type, start, data, padName(rawName));
    this.pulses.splice(this.pos, this.pulses.length - this.pos, ...tail);
    this.files = decodeFiles(this.pulses);
    this.seek(this.pulses.length);
    this.dirty = true;
  }
}

function padName(raw: Uint8Array): Uint8Array {
  const n = new Uint8Array(16).fill(0x20);
  n.set(raw.subarray(0, 16));
  // .t64 names are padded with A0h or 00h; the KERNAL pads with spaces.
  for (let i = 0; i < 16; i++) if (n[i] === 0xa0 || n[i] === 0) n[i] = 0x20;
  return n;
}

/** The KERNAL's LOAD name match: `*` ends the comparison, `?` matches any character. */
export function nameMatches(want: Uint8Array, have: Uint8Array): boolean {
  for (let i = 0; i < want.length; i++) {
    if (want[i] === 0x2a) return true;
    if (want[i] === 0x3f) continue;
    if (want[i] !== have[i]) return false;
  }
  return true;
}

/** PETSCII name to text, trailing spaces dropped. */
export function nameText(raw: Uint8Array): string {
  let s = '';
  for (const b of raw) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0xa0 ? ' ' : '?';
  return s.trimEnd();
}

// ---- writing ----------------------------------------------------------------

function pushByte(p: number[], b: number): void {
  p.push(LONG, MEDIUM);
  let parity = 1;
  for (let i = 0; i < 8; i++) {
    const bit = (b >> i) & 1;
    parity ^= bit;
    if (bit) p.push(MEDIUM, SHORT); else p.push(SHORT, MEDIUM);
  }
  if (parity) p.push(MEDIUM, SHORT); else p.push(SHORT, MEDIUM);
}

function pushBlock(p: number[], body: Uint8Array, repeat: boolean): void {
  for (let c = 9; c >= 1; c--) pushByte(p, repeat ? c : 0x80 | c);
  let check = 0;
  for (const b of body) { pushByte(p, b); check ^= b; }
  pushByte(p, check);
  p.push(LONG, SHORT); // end of block
}

/** Writes a file as the KERNAL's SAVE does: leader, header twice, leader, data twice. */
export function encodeFile(p: number[], type: number, start: number, data: Uint8Array, rawName: Uint8Array): void {
  const end = start + data.length;
  const header = new Uint8Array(192).fill(0x20);
  header[0] = type;
  header[1] = start & 0xff; header[2] = start >> 8;
  header[3] = end & 0xff; header[4] = (end >> 8) & 0xff;
  header.set(rawName.subarray(0, 16), 5);
  for (let i = 0; i < 0x6a00; i++) p.push(SHORT);
  pushBlock(p, header, false);
  for (let i = 0; i < 79; i++) p.push(SHORT);
  pushBlock(p, header, true);
  for (let i = 0; i < 78; i++) p.push(SHORT);
  for (let i = 0; i < 0x1500; i++) p.push(SHORT);
  pushBlock(p, data, false);
  for (let i = 0; i < 79; i++) p.push(SHORT);
  pushBlock(p, data, true);
  for (let i = 0; i < 78; i++) p.push(SHORT);
}

// ---- reading ----------------------------------------------------------------

/** S, M or L for a pulse in the KERNAL's format (null if it is none of them). */
function kind(cycles: number): 0 | 1 | 2 | null {
  const v = cycles / 8;
  if (v < 0x24 || v > 0x70) return null;
  return v < 0x3a ? 0 : v < 0x4c ? 1 : 2;
}

interface Block { bytes: number[]; start: number; end: number }

/** Every block of KERNAL-format bytes on the tape, with where it is. */
function decodeBlocks(pulses: number[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let i = 0;
  const n = pulses.length;
  while (i + 1 < n) {
    const a = kind(pulses[i]), b = kind(pulses[i + 1]);
    if (a === 2 && b === 1) {
      // A byte: 9 pairs follow.
      if (i + 19 >= n) break;
      let v = 0, parity = 1, ok = true;
      for (let k = 0; k < 9; k++) {
        const x = kind(pulses[i + 2 + k * 2]), y = kind(pulses[i + 3 + k * 2]);
        let bit: number;
        if (x === 0 && y === 1) bit = 0;
        else if (x === 1 && y === 0) bit = 1;
        else { ok = false; break; }
        if (k < 8) { v |= bit << k; parity ^= bit; } else if (bit !== parity) ok = false;
      }
      if (ok) {
        if (!cur) { cur = { bytes: [], start: i, end: i }; blocks.push(cur); }
        cur.bytes.push(v);
        i += 20;
        cur.end = i;
        continue;
      }
    }
    if (a === 2 && b === 0) { if (cur) cur.end = i + 2; cur = null; i += 2; continue; } // end of block
    if (a === 0 && cur && cur.bytes.length > 0) cur = null; // leader: the block is over
    i++;
  }
  return blocks;
}

/** Pairs header and data blocks into files (the first good copy of each). */
function decodeFiles(pulses: number[]): TapeFile[] {
  const blocks = decodeBlocks(pulses).filter(b => b.bytes.length > 10);
  const files: TapeFile[] = [];
  /** A block's payload if its countdown and checksum are good. */
  const payload = (b: Block): { first: boolean; data: number[] } | null => {
    const c = b.bytes;
    const first = c[0] === 0x89;
    for (let k = 0; k < 9; k++) if (c[k] !== (first ? 0x89 - k : 9 - k)) return null;
    const data = c.slice(9, -1);
    let x = 0;
    for (const v of data) x ^= v;
    return x === c[c.length - 1] ? { first, data } : null;
  };
  let i = 0;
  while (i < blocks.length) {
    const h = payload(blocks[i]);
    if (!h || h.data.length !== 192 || ![1, 3, 4, 5].includes(h.data[0])) { i++; continue; }
    const head = h.data;
    const type = head[0];
    const start = head[1] | (head[2] << 8);
    const end = head[3] | (head[4] << 8);
    const rawName = Uint8Array.from(head.slice(5, 21));
    const pulseStart = leaderStart(pulses, blocks[i].start);
    // Skip the header's repeat.
    let j = i + 1;
    if (j < blocks.length && payload(blocks[j])?.data.length === 192 && !payload(blocks[j])!.first) j++;
    if (type === 1 || type === 3) {
      // The data block, or its repeat if the first copy is bad.
      let data: number[] | null = null;
      let last = j;
      for (let k = j; k < Math.min(j + 2, blocks.length); k++) {
        const d = payload(blocks[k]);
        if (!d || d.data.length !== ((end - start) & 0xffff)) continue;
        data ??= d.data;
        last = k;
      }
      if (data) {
        files.push({ type, name: nameText(rawName), rawName, start, data: Uint8Array.from(data.slice(0, end - start)), pulseStart, pulseEnd: blocks[last].end });
        i = last + 1;
        continue;
      }
    } else {
      files.push({ type, name: nameText(rawName), rawName, start, data: new Uint8Array(0), pulseStart, pulseEnd: blocks[j - 1].end });
    }
    i = j;
  }
  return files;
}

/** Back from a block to the start of the short-pulse leader before it. */
function leaderStart(pulses: number[], i: number): number {
  while (i > 0 && kind(pulses[i - 1]) === 0) i--;
  return i;
}
