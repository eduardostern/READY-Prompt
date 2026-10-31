/**
 * A virtual 1541 on the serial bus, answering the KERNAL's bus routines
 * (the machine traps LISTEN, TALK, SECOND, TKSA, CIOUT, ACPTR, UNLSN and
 * UNTLK while the KERNAL is in). Everything above them is the KERNAL's own
 * code: LOAD, SAVE, OPEN, GET#, PRINT#, CLOSE, its messages and errors.
 *
 * The drive's DOS is the part of CBM DOS 2.6 programs use: 16 channels,
 * channel 0 for LOAD and 1 for SAVE, "$" as a directory program, files
 * opened as "name,S,R" / ",P,W" / ",S,A", "@0:" to replace, and channel 15
 * for commands (I, N:, S:, R:, V) and the error message ("62,FILE NOT
 * FOUND,00,00"). Fast loaders that talk to the drive's own CPU need a real
 * 1541 and its ROM, which this is not.
 */
import { D64, DiskError, matches, petsciiName, TYPES } from './disk';

const ST_TIMEOUT_READ = 0x02, ST_EOI = 0x40;

interface Channel {
  /** Bytes to send (reading) and where we are. */
  data: Uint8Array;
  pos: number;
  /** Bytes received (writing): written to disk on CLOSE. */
  writing?: { name: Uint8Array; type: number; bytes: number[]; replace: boolean; append?: boolean };
}

export class Drive {
  disk: D64 | null = null;
  private channels: (Channel | null)[] = new Array(16).fill(null);
  private error: [number, string, number, number] = [73, 'CBM DOS V2.6 1541', 0, 0];
  private errorPos = 0;
  /** Bytes of the name (or command) being sent after SECOND Fx / 6F. */
  private incoming: number[] | null = null;
  private incomingOpen = -1;
  /** Bytes of a command written to channel 15 with PRINT#. */
  private command: number[] = [];
  /** What LISTEN/TALK + SECOND/TKSA selected. */
  listening = false;
  talking = false;
  private secondary = 0;
  /** The light: a file is open or the drive just worked. */
  busy = 0;

  constructor(readonly device: number) {}

  insert(d: D64 | null): void {
    this.disk = d;
    this.channels.fill(null);
    this.setError(0, 'OK');
  }

  reset(): void {
    this.channels.fill(null);
    this.listening = this.talking = false;
    this.incoming = null;
    this.command = [];
    this.setError(73, 'CBM DOS V2.6 1541');
  }

  private setError(code: number, text: string, t = 0, s = 0): void {
    this.error = [code, text, t, s];
    this.errorPos = 0;
  }

  /** The error channel's message, as the drive sends it. */
  private errorBytes(): Uint8Array {
    const [c, text, t, s] = this.error;
    const two = (n: number) => String(n).padStart(2, '0');
    return Uint8Array.from([...`${two(c)},${text},${two(t)},${two(s)}\r`].map(ch => ch.charCodeAt(0)));
  }

  // ---- the bus ----

  listen(): void { this.listening = true; this.talking = false; }
  talk(): void { this.talking = true; this.listening = false; }

  /** SECOND after LISTEN: 6x data, Ex close, Fx open. */
  second(a: number): void {
    this.secondary = a & 0x0f;
    switch (a & 0xf0) {
      case 0xf0: this.incoming = []; this.incomingOpen = this.secondary; break;
      case 0xe0: this.close(this.secondary); break;
      default: if (this.secondary === 15) this.incoming = null; break;
    }
  }

  /** TKSA after TALK: the channel to read. */
  tksa(a: number): void { this.secondary = a & 0x0f; }

  /** A byte from the C64 while listening. */
  ciout(b: number): void {
    this.busy = 30;
    if (this.incoming) { this.incoming.push(b); return; }
    if (this.secondary === 15) { this.command.push(b); return; }
    const ch = this.channels[this.secondary];
    if (ch?.writing) ch.writing.bytes.push(b);
    // Bytes for a channel whose OPEN failed are dropped; the OPEN's error stays.
    else if (this.error[0] === 0) this.setError(61, 'FILE NOT OPEN');
  }

  unlisten(): void {
    if (this.incoming) {
      const name = Uint8Array.from(this.incoming);
      this.incoming = null;
      if (this.incomingOpen === 15) this.runCommand(name);
      else this.open(this.incomingOpen, name);
    } else if (this.secondary === 15 && this.command.length) {
      const cmd = Uint8Array.from(this.command);
      this.command = [];
      this.runCommand(cmd);
    }
    this.listening = false;
  }

  untalk(): void { this.talking = false; }

  /** A byte for the C64 while talking: [byte, status bits]. */
  acptr(): [number, number] {
    this.busy = 30;
    if (this.secondary === 15) {
      const msg = this.errorBytes();
      const b = msg[this.errorPos++];
      if (this.errorPos >= msg.length) { this.setError(0, 'OK'); return [b, ST_EOI]; }
      return [b, 0];
    }
    const ch = this.channels[this.secondary];
    if (!ch || ch.writing || ch.pos >= ch.data.length) return [0x0d, ST_EOI | ST_TIMEOUT_READ];
    const b = ch.data[ch.pos++];
    return [b, ch.pos >= ch.data.length ? ST_EOI : 0];
  }

  // ---- the DOS ----

  private open(sa: number, raw: Uint8Array): void {
    this.channels[sa] = null;
    if (!this.disk) { this.setError(74, 'DRIVE NOT READY'); return; }
    try {
      const spec = parseName(raw);
      if (spec.name[0] === 0x24 /* $ */ && sa === 0) {
        this.channels[sa] = { data: directoryProgram(this.disk, spec.name.subarray(1)), pos: 0 };
        this.setError(0, 'OK');
        return;
      }
      if (spec.name[0] === 0x23 /* # */) { this.setError(70, 'NO CHANNEL'); return; }
      const write = sa === 1 || spec.mode === 'W' || spec.mode === 'A';
      const type = sa <= 1 ? 2 : spec.type ?? (write ? 1 : undefined);
      if (!write) {
        const e = this.disk.find(spec.name, sa === 0 ? undefined : type);
        if (!e) { this.setError(62, 'FILE NOT FOUND'); return; }
        this.channels[sa] = { data: this.disk.read(e), pos: 0 };
        this.setError(0, 'OK');
        return;
      }
      if (!spec.name.length || hasWildcard(spec.name)) { this.setError(33, 'SYNTAX ERROR'); return; }
      const existing = this.disk.find(spec.name);
      if (spec.mode === 'A') {
        if (!existing) { this.setError(62, 'FILE NOT FOUND'); return; }
        this.channels[sa] = { data: new Uint8Array(0), pos: 0, writing: { name: spec.name, type: existing.type, bytes: [...this.disk.read(existing)], replace: true, append: true } };
      } else {
        if (existing && !spec.replace) { this.setError(63, 'FILE EXISTS'); return; }
        this.channels[sa] = { data: new Uint8Array(0), pos: 0, writing: { name: spec.name, type: type ?? 2, bytes: [], replace: spec.replace } };
      }
      this.setError(0, 'OK');
    } catch (e) {
      this.fail(e);
    }
  }

  private close(sa: number): void {
    const ch = this.channels[sa];
    this.channels[sa] = null;
    if (!ch?.writing || !this.disk) return;
    const w = ch.writing;
    try {
      const old = this.disk.find(w.name);
      if (old && w.replace) this.disk.scratch(old);
      this.disk.write(w.name, w.type, Uint8Array.from(w.bytes));
      this.setError(0, 'OK');
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    if (e instanceof DiskError) this.setError(e.code, e.message, e.track, e.sector);
    else this.setError(74, 'DRIVE NOT READY');
  }

  /** Channel 15 commands. */
  private runCommand(raw: Uint8Array): void {
    let cmd = [...raw];
    while (cmd.length && (cmd[cmd.length - 1] === 0x0d || cmd[cmd.length - 1] === 0x20)) cmd.pop();
    if (!cmd.length) return;
    const text = String.fromCharCode(...cmd);
    const letter = text[0].toUpperCase();
    const arg = text.includes(':') ? text.slice(text.indexOf(':') + 1) : '';
    const bytes = (s: string) => Uint8Array.from([...s].map(c => c.charCodeAt(0)));
    try {
      switch (letter) {
        case 'I': case 'U':
          if (letter === 'U' && /^U[J:]/i.test(text)) this.reset(); else this.setError(0, 'OK');
          return;
        case 'N': {
          if (!this.disk) { this.setError(74, 'DRIVE NOT READY'); return; }
          const [name, id] = arg.split(',');
          this.disk.format(bytes(name ?? ''), id ? bytes(id) : this.disk.diskId.subarray(0, 2));
          this.channels.fill(null);
          this.setError(0, 'OK');
          return;
        }
        case 'S': {
          if (!this.disk) { this.setError(74, 'DRIVE NOT READY'); return; }
          let n = 0;
          for (const pattern of arg.split(',')) {
            const p = bytes(pattern);
            for (const e of this.disk.entries()) {
              if (e.type !== 0 && !e.locked && matches(p, e.name)) { this.disk.scratch(e); n++; }
            }
          }
          this.setError(1, 'FILES SCRATCHED', n, 0);
          return;
        }
        case 'R': {
          if (!this.disk) { this.setError(74, 'DRIVE NOT READY'); return; }
          const [to, from] = arg.split('=');
          if (!to || !from) { this.setError(30, 'SYNTAX ERROR'); return; }
          if (this.disk.find(bytes(to))) { this.setError(63, 'FILE EXISTS'); return; }
          const e = this.disk.find(bytes(from));
          if (!e) { this.setError(62, 'FILE NOT FOUND'); return; }
          this.disk.rename(e, bytes(to));
          this.setError(0, 'OK');
          return;
        }
        case 'V': this.setError(0, 'OK'); return;
        default: this.setError(31, 'SYNTAX ERROR');
      }
    } catch (e) {
      this.fail(e);
    }
  }
}

interface NameSpec { name: Uint8Array; type?: number; mode?: string; replace: boolean }

/** "[@][0:]NAME[,type[,mode]]". */
function parseName(raw: Uint8Array): NameSpec {
  let s = [...raw];
  let replace = false;
  if (s[0] === 0x40) { replace = true; s = s.slice(1); }
  const colon = s.indexOf(0x3a);
  if (colon >= 0 && colon <= 2) s = s.slice(colon + 1);
  const parts: number[][] = [[]];
  for (const b of s) { if (b === 0x2c) parts.push([]); else parts[parts.length - 1].push(b); }
  const spec: NameSpec = { name: Uint8Array.from(parts[0].slice(0, 16)), replace };
  for (const p of parts.slice(1)) {
    const c = String.fromCharCode(p[0] ?? 0).toUpperCase();
    if ('SPUL'.includes(c) && spec.type === undefined && c !== 'L') spec.type = { S: 1, P: 2, U: 3 }[c as 'S' | 'P' | 'U'];
    else if ('RWAM'.includes(c)) spec.mode = c;
  }
  return spec;
}

function hasWildcard(n: Uint8Array): boolean {
  return n.includes(0x2a) || n.includes(0x3f);
}

/** The directory as the 1541 sends it for LOAD"$",8: a BASIC program at 0401h. */
export function directoryProgram(d: D64, pattern: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out: number[] = [0x01, 0x04];
  let addr = 0x0401;
  const line = (num: number, text: number[]) => {
    const next = addr + 4 + text.length + 1;
    out.push(next & 0xff, next >> 8, num & 0xff, num >> 8, ...text, 0);
    addr = next;
  };
  const str = (s: string) => [...s].map(c => c.charCodeAt(0));
  const name16 = (raw: Uint8Array) => [...raw.subarray(0, 16)].map(b => (b === 0xa0 ? 0x20 : b));
  const id = [...d.diskId].map(b => (b === 0xa0 ? 0x20 : b));
  line(0, [0x12, 0x22, ...name16(d.diskName), 0x22, 0x20, ...id]);
  const filter = pattern[0] === 0x3a ? pattern.subarray(1) : pattern;
  for (const e of d.entries()) {
    if (filter.length && !matches(filter, e.name)) continue;
    const n = [...e.name.subarray(0, 16)];
    let len = n.indexOf(0xa0);
    if (len < 0) len = 16;
    const blocks = String(e.blocks);
    const text = [
      ...str(' '.repeat(Math.max(1, 4 - blocks.length))),
      0x22, ...n.slice(0, len), 0x22,
      ...str(' '.repeat(16 - len)),
      ...str(e.closed ? ' ' : '*'), ...str(TYPES[e.type]), ...str(e.locked ? '<' : ' '),
    ];
    line(e.blocks, text);
  }
  line(d.blocksFree, [...str('BLOCKS FREE.'), ...str(' '.repeat(13))]);
  out.push(0, 0);
  return Uint8Array.from(out);
}

export { petsciiName };
