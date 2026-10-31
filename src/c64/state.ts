/**
 * Save states: the whole machine as it is, to put back later.
 *
 * Each chip's own plain data (numbers, flags, typed arrays, arrays of
 * plain objects such as the sprites and the SID's voices) is copied as it
 * is, leaving out what is wiring or comes from outside: ROMs, the bus
 * callbacks, the trap tables, the picture. A state is JSON (typed arrays
 * as base64), deflated, after an 8-byte magic. The cartridge, tape and
 * disks themselves are not in it, only where they are (bank, position):
 * the state goes back onto whatever is plugged in.
 */
import { deflateSync, inflateSync } from 'fflate';
import type { C64, Model } from './machine';
import type { SidModel } from './sid';

const MAGIC = 'RDYSTAT1';

type Plain = Record<string, unknown>;

/** Fields that are not state (wiring, ROMs, things rebuilt from the model). */
const SKIP: Record<string, Set<string>> = {
  machine: new Set(['basic', 'kernal', 'chargen', 'trapAt', 'traps', 'onReady', 'cart', 'tape', 'drives', 'busDrive',
    'keys', 'cpu', 'vic', 'sid', 'cia1', 'cia2', 'swiftlink', 'typing', 'restore', 'joy1', 'joy2', 'fastTape', 'tapePlay']),
  cpu: new Set(['read', 'write']),
  vic: new Set(['read', 'frame', 'timing']),
  sid: new Set(['samples', 'sampleRate', 'model']),
  cia: new Set(['ports']),
  cart: new Set(['crt', 'lo', 'hi', 'changed', 'type', 'name']),
};

function encodeTyped(a: ArrayBufferView & { length: number }): { $t: string; b: string } {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { $t: a.constructor.name, b: btoa(s) };
}

function decodeInto(target: ArrayBufferView, enc: { b: string }): void {
  const s = atob(enc.b);
  const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  for (let i = 0; i < Math.min(s.length, bytes.length); i++) bytes[i] = s.charCodeAt(i);
}

function isTyped(v: unknown): v is ArrayBufferView & { length: number } {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** An object's own state fields, copied. */
export function grab(o: object, skip: Set<string> = new Set()): Plain {
  const out: Plain = {};
  for (const [k, v] of Object.entries(o)) {
    if (skip.has(k) || typeof v === 'function') continue;
    if (isTyped(v)) out[k] = encodeTyped(v);
    else if (Array.isArray(v)) out[k] = v.map(x => (x && typeof x === 'object' ? (isTyped(x) ? encodeTyped(x) : grab(x)) : x));
    else if (v === null || typeof v !== 'object') out[k] = v;
    else if (Object.getPrototypeOf(v) === Object.prototype) out[k] = grab(v);
  }
  return out;
}

/** Puts fields copied by `grab` back into `o`. */
export function put(o: object, data: Plain, skip: Set<string> = new Set()): void {
  const t = o as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) {
    if (skip.has(k) || !(k in t)) continue;
    const cur = t[k];
    if (isTyped(cur) && v && typeof v === 'object' && '$t' in (v as Plain)) decodeInto(cur, v as { b: string });
    else if (Array.isArray(cur) && Array.isArray(v)) {
      if (cur.length && cur[0] && typeof cur[0] === 'object') v.forEach((x, i) => { if (cur[i]) put(cur[i], x as Plain); });
      else t[k] = [...v];
    } else if (cur && typeof cur === 'object' && v && typeof v === 'object' && !Array.isArray(v)) put(cur, v as Plain);
    else t[k] = v;
  }
}

export interface MachineState {
  model: Model;
  sidModel: SidModel;
  machine: Plain; cpu: Plain; vic: Plain; sid: Plain; cia1: Plain; cia2: Plain;
  cart?: Plain;
  tape?: { pos: number; left: number };
}

/** The machine as it is now. */
export function captureState(c: C64): MachineState {
  return {
    model: c.model,
    sidModel: c.sid.model,
    machine: grab(c, SKIP.machine),
    cpu: grab(c.cpu, SKIP.cpu),
    vic: grab(c.vic, SKIP.vic),
    sid: grab(c.sid, SKIP.sid),
    cia1: grab(c.cia1, SKIP.cia),
    cia2: grab(c.cia2, SKIP.cia),
    cart: c.cart ? grab(c.cart, SKIP.cart) : undefined,
    tape: c.tape ? { pos: c.tape.pos, left: c.tape.left } : undefined,
  };
}

/** Puts a captured state back (switching model first if it must). */
export function restoreState(c: C64, s: MachineState): void {
  if (s.model !== c.model) c.setModel(s.model);
  c.setSidModel(s.sidModel);
  put(c, s.machine, SKIP.machine);
  put(c.cpu, s.cpu, SKIP.cpu);
  put(c.vic, s.vic, SKIP.vic);
  put(c.sid, s.sid, SKIP.sid);
  put(c.cia1, s.cia1, SKIP.cia);
  put(c.cia2, s.cia2, SKIP.cia);
  if (c.cart && s.cart) put(c.cart, s.cart, SKIP.cart);
  if (c.tape && s.tape) { c.tape.pos = s.tape.pos; c.tape.left = s.tape.left; }
  c.afterStateLoad();
}

/** A state as a file. */
export function saveState(c: C64): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(captureState(c)));
  const body = deflateSync(json, { level: 6 });
  const out = new Uint8Array(8 + body.length);
  out.set([...MAGIC].map(ch => ch.charCodeAt(0)));
  out.set(body, 8);
  return out;
}

export function isState(data: Uint8Array): boolean {
  return String.fromCharCode(...data.subarray(0, 8)) === MAGIC;
}

export function loadState(c: C64, data: Uint8Array): void {
  if (!isState(data)) throw new Error('not a READY-Prompt state');
  restoreState(c, JSON.parse(new TextDecoder().decode(inflateSync(data.subarray(8)))));
}

/** The last 30 seconds, one state a second, to step back through. */
export class Rewind {
  private ring: MachineState[] = [];
  private frames = 0;
  constructor(readonly every = 50, readonly keep = 30) {}

  tick(c: C64): void {
    if (++this.frames < this.every) return;
    this.frames = 0;
    this.ring.push(captureState(c));
    if (this.ring.length > this.keep) this.ring.shift();
  }

  /** Goes back to the previous state; false when there is none. */
  back(c: C64): boolean {
    // The newest state is less than a second old: skip it if there is an older one.
    if (this.ring.length > 1 && this.frames < this.every / 2) this.ring.pop();
    const s = this.ring.pop();
    if (!s) return false;
    restoreState(c, s);
    this.frames = 0;
    return true;
  }

  get seconds(): number { return this.ring.length; }

  clear(): void { this.ring = []; this.frames = 0; }
}
