/**
 * Cartridges from .crt files: the ROM banks, the GAME and EXROM lines, and
 * how each kind switches banks.
 *
 * A .crt is a 64-byte header ("C64 CARTRIDGE", hardware type, the lines
 * as the cartridge sets them at power-on, a name) and CHIP packets: each
 * a bank number, a load address (8000h ROML, A000h or E000h ROMH) and the
 * bytes.
 */
import type { Cartridge } from './machine';

export const CRT_TYPES: Record<number, string> = {
  0: 'Normal', 1: 'Action Replay', 3: 'Final Cartridge III', 4: "Simons' BASIC", 5: 'Ocean', 7: 'Fun Play',
  15: 'C64 Game System', 17: 'Dinamic', 19: 'Magic Desk', 32: 'EasyFlash',
};
const SUPPORTED = new Set([0, 4, 5, 7, 15, 17, 19, 32]);

export class CartError extends Error {}

interface Chip { bank: number; address: number; data: Uint8Array }

export interface CrtFile { type: number; exrom: boolean; game: boolean; name: string; chips: Chip[] }

export function parseCrt(data: Uint8Array): CrtFile {
  const sig = String.fromCharCode(...data.subarray(0, 16));
  if (!sig.startsWith('C64 CARTRIDGE')) throw new CartError('not a C64 .crt file');
  const be32 = (o: number) => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  const be16 = (o: number) => (data[o] << 8) | data[o + 1];
  const headerLen = be32(16) || 0x40;
  const type = be16(22);
  // In the header 0 means the line is pulled low (active).
  const exrom = data[24] !== 0, game = data[25] !== 0;
  let name = '';
  for (let i = 0x20; i < 0x40 && data[i]; i++) name += String.fromCharCode(data[i]);
  const chips: Chip[] = [];
  let o = headerLen;
  while (o + 16 <= data.length) {
    if (String.fromCharCode(...data.subarray(o, o + 4)) !== 'CHIP') break;
    const len = be32(o + 4);
    const size = be16(o + 14);
    chips.push({ bank: be16(o + 10), address: be16(o + 12), data: data.slice(o + 16, o + 16 + size) });
    o += Math.max(len, 16);
  }
  if (!chips.length) throw new CartError('no ROM in this .crt');
  return { type, exrom, game, name: name.trim(), chips };
}

/** A cartridge from a .crt's bytes. */
export function cartridgeFromCrt(data: Uint8Array): CrtCartridge {
  const crt = parseCrt(data);
  if (!SUPPORTED.has(crt.type)) {
    throw new CartError(`${CRT_TYPES[crt.type] ?? `type ${crt.type}`} cartridges are not supported yet`);
  }
  return new CrtCartridge(crt);
}

export class CrtCartridge implements Cartridge {
  game = true;
  exrom = true;
  readonly type: number;
  readonly name: string;
  /** 8K banks for ROML (8000h) and ROMH (A000h/E000h). */
  private readonly lo: (Uint8Array | undefined)[] = [];
  private readonly hi: (Uint8Array | undefined)[] = [];
  private bank = 0;
  /** EasyFlash: control register DE02h and its 256 bytes of RAM at DF00h. */
  private control = 0;
  private readonly ram = new Uint8Array(256);
  /** The machine re-reads GAME/EXROM through this. */
  changed?: () => void;

  constructor(private readonly crt: CrtFile) {
    this.type = crt.type;
    this.name = crt.name;
    for (const c of crt.chips) {
      if (c.address === 0x8000) {
        this.lo[c.bank] = c.data.subarray(0, 0x2000);
        // A 16K chip at 8000h is ROML and ROMH together.
        if (c.data.length > 0x2000) this.hi[c.bank] = c.data.subarray(0x2000, 0x4000);
      } else {
        this.hi[c.bank] = c.data.subarray(0, 0x2000);
      }
    }
    this.reset();
  }

  reset(): void {
    this.bank = 0;
    this.control = 0;
    this.ram.fill(0);
    if (this.type === 32) this.setEasyFlash(0);
    else this.setLines(this.crt.game, this.crt.exrom);
  }

  private setLines(game: boolean, exrom: boolean): void {
    this.game = game;
    this.exrom = exrom;
    this.changed?.();
  }

  private setEasyFlash(v: number): void {
    this.control = v;
    // Mode 0 is the boot jumper: Ultimax, so the C64 starts from the cartridge's ROMH.
    if (!(v & 4)) this.setLines(false, true);
    else this.setLines(!(v & 1), !(v & 2));
  }

  roml(a: number): number {
    const b = this.lo[this.bank] ?? this.lo[0];
    return b ? b[a & 0x1fff] ?? 0xff : 0xff;
  }

  romh(a: number): number {
    // Ocean and the 8K-mode types show the same bank at A000h when it has no ROMH.
    const b = this.hi[this.bank] ?? (this.type === 5 ? this.lo[this.bank] : this.hi[0]);
    return b ? b[a & 0x1fff] ?? 0xff : 0xff;
  }

  io1Read(a: number): number | undefined {
    switch (this.type) {
      case 4: this.setLines(true, false); return undefined; // Simons' BASIC: reading DE00h is 8K mode
      case 17: this.bank = a & 0x0f; return undefined; // Dinamic: the address read picks the bank
      case 15: this.bank = 0; return undefined;
      case 32: return undefined;
    }
    return undefined;
  }

  io1Write(a: number, v: number): void {
    switch (this.type) {
      case 4: this.setLines(false, false); return; // writing DE00h: 16K mode
      case 5: this.bank = v & 0x3f; return;
      case 7: this.bank = ((v >> 3) & 7) | ((v & 1) << 3); if ((v & 0xc6) === 0x86) this.setLines(true, true); return;
      case 15: this.bank = a & 0x3f; return; // System 3: the address written picks the bank
      case 19: // Magic Desk: bit 7 switches the cartridge off
        this.bank = v & 0x7f;
        this.setLines(true, !!(v & 0x80));
        return;
      case 32:
        if ((a & 2) === 0) this.bank = v & 0x3f;
        else this.setEasyFlash(v);
        return;
    }
  }

  io2Read(a: number): number | undefined {
    return this.type === 32 ? this.ram[a & 0xff] : undefined;
  }

  io2Write(a: number, v: number): void {
    if (this.type === 32) this.ram[a & 0xff] = v;
  }

  /** Writes to the ROM areas go nowhere (EasyFlash's flash chips are not programmed here). */
  writeRom(): void {}
}

/** Builds a .crt (for tests and the built-in cartridges): type, lines, and 8K chips. */
export function makeCrt(type: number, game: boolean, exrom: boolean, name: string, chips: Chip[]): Uint8Array {
  const parts: number[] = [];
  const be16 = (v: number) => [v >> 8, v & 0xff];
  const be32 = (v: number) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const head = new Uint8Array(0x40);
  head.set([...'C64 CARTRIDGE   '].map(c => c.charCodeAt(0)));
  head.set(be32(0x40), 16);
  head.set([1, 0], 20);
  head.set(be16(type), 22);
  head[24] = exrom ? 1 : 0; head[25] = game ? 1 : 0;
  head.set([...name.slice(0, 32)].map(c => c.charCodeAt(0)), 0x20);
  parts.push(...head);
  for (const c of chips) {
    parts.push(...'CHIP'.split('').map(ch => ch.charCodeAt(0)), ...be32(16 + c.data.length), ...be16(0), ...be16(c.bank),
      ...be16(c.address), ...be16(c.data.length), ...c.data);
  }
  return Uint8Array.from(parts);
}
