/**
 * .d64 disk images: the 1541's 35 (or 40) tracks of 256-byte sectors.
 *
 * Track 18 holds the BAM (sector 0: free-sector bitmaps, disk name, ID)
 * and the directory (from sector 1: 8 entries of 32 bytes per sector).
 * A file is a chain of sectors: bytes 0-1 are the next track/sector, or
 * 0 and the index of the last byte used. New files are laid out as the
 * 1541 does it: the free track nearest the directory first, every tenth
 * sector (the interleave that let it read on while the C64 caught up).
 */

export const TYPES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'];
const DIR_TRACK = 18;
const INTERLEAVE = 10;

export function sectorsIn(track: number): number {
  return track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17;
}

export interface DirEntry {
  /** Index in the directory (sector order). */
  index: number;
  type: number; // 0-4
  closed: boolean;
  locked: boolean;
  name: Uint8Array; // 16 bytes, A0h padded
  track: number;
  sector: number;
  blocks: number;
  /** Where the entry is: directory sector and offset. */
  dirTrack: number;
  dirSector: number;
  offset: number;
}

export class DiskError extends Error {
  constructor(readonly code: number, message: string, readonly track = 0, readonly sector = 0) {
    super(message);
  }
}

export class D64 {
  readonly data: Uint8Array;
  readonly tracks: number;
  private readonly offsets: number[] = [];
  /** Something was written since it was inserted. */
  dirty = false;

  constructor(data: Uint8Array, public name = 'disk.d64') {
    const t = data.length >= 768 * 256 ? 40 : 35;
    if (data.length < 683 * 256) throw new DiskError(74, 'not a .d64 image (too short)');
    this.tracks = t;
    this.data = data.slice(0, (t === 40 ? 768 : 683) * 256);
    let off = 0;
    for (let tr = 1; tr <= t; tr++) { this.offsets[tr] = off; off += sectorsIn(tr) * 256; }
  }

  /** A freshly formatted disk (what N:name,id leaves). */
  static blank(diskName = 'READY-PROMPT', id = 'RP', file = 'blank.d64'): D64 {
    const d = new D64(new Uint8Array(683 * 256), file);
    d.format(petsciiName(diskName), petsciiName(id).subarray(0, 2));
    d.dirty = false;
    return d;
  }

  private at(track: number, sector: number): number {
    if (track < 1 || track > this.tracks || sector < 0 || sector >= sectorsIn(track)) {
      throw new DiskError(66, 'ILLEGAL TRACK OR SECTOR', track, sector);
    }
    return this.offsets[track] + sector * 256;
  }

  sector(track: number, sector: number): Uint8Array {
    const o = this.at(track, sector);
    return this.data.subarray(o, o + 256);
  }

  // ---- BAM ----

  private get bam(): Uint8Array { return this.sector(DIR_TRACK, 0); }

  get diskName(): Uint8Array { return this.bam.slice(0x90, 0xa0); }
  get diskId(): Uint8Array { return this.bam.slice(0xa2, 0xa7); }

  isFree(track: number, sector: number): boolean {
    if (track > 35) return false; // tracks 36-40 are outside the standard BAM
    return !!(this.bam[4 * track + 1 + (sector >> 3)] & (1 << (sector & 7)));
  }

  private setFree(track: number, sector: number, free: boolean): void {
    if (track > 35) return;
    const b = this.bam;
    const i = 4 * track + 1 + (sector >> 3), bit = 1 << (sector & 7);
    const was = !!(b[i] & bit);
    if (was === free) return;
    if (free) { b[i] |= bit; b[4 * track]++; } else { b[i] &= ~bit; b[4 * track]--; }
  }

  /** Free blocks, the directory track left out (as the 1541 counts them). */
  get blocksFree(): number {
    let n = 0;
    for (let t = 1; t <= 35; t++) if (t !== DIR_TRACK) n += this.bam[4 * t];
    return n;
  }

  format(name: Uint8Array, id: Uint8Array): void {
    this.data.fill(0);
    const b = this.bam;
    b[0] = DIR_TRACK; b[1] = 1; b[2] = 0x41;
    for (let t = 1; t <= 35; t++) {
      const n = sectorsIn(t);
      b[4 * t] = n;
      for (let s = 0; s < 24; s++) if (s < n) b[4 * t + 1 + (s >> 3)] |= 1 << (s & 7);
    }
    b.fill(0xa0, 0x90, 0xab);
    b.set(name.subarray(0, 16), 0x90);
    b.set(id.subarray(0, 2), 0xa2);
    b[0xa5] = 0x32; b[0xa6] = 0x41; // "2A"
    this.setFree(DIR_TRACK, 0, false);
    this.setFree(DIR_TRACK, 1, false);
    const dir = this.sector(DIR_TRACK, 1);
    dir[0] = 0; dir[1] = 0xff;
    this.dirty = true;
  }

  /** The next free sector for a file, from the 1541's search order. */
  private allocate(prevTrack: number, prevSector: number): [number, number] {
    const tryTrack = (t: number, from: number): number => {
      const n = sectorsIn(t);
      for (let k = 0; k < n; k++) {
        const s = (from + k) % n;
        if (this.isFree(t, s)) return s;
      }
      return -1;
    };
    if (prevTrack) {
      const s = tryTrack(prevTrack, prevSector + INTERLEAVE);
      if (s >= 0) { this.setFree(prevTrack, s, false); return [prevTrack, s]; }
    }
    for (let d = 1; d < 35; d++) {
      for (const t of [DIR_TRACK - d, DIR_TRACK + d]) {
        if (t < 1 || t > 35) continue;
        const s = tryTrack(t, 0);
        if (s >= 0) { this.setFree(t, s, false); return [t, s]; }
      }
    }
    throw new DiskError(72, 'DISK FULL');
  }

  // ---- directory ----

  entries(withDeleted = false): DirEntry[] {
    const out: DirEntry[] = [];
    let t = DIR_TRACK, s = 1, index = 0;
    const seen = new Set<number>();
    while (t && !seen.has(t * 256 + s)) {
      seen.add(t * 256 + s);
      let sec: Uint8Array;
      try { sec = this.sector(t, s); } catch { break; }
      for (let e = 0; e < 8; e++, index++) {
        const o = e * 32;
        const ft = sec[o + 2];
        if (!withDeleted && (ft & 7) === 0 && !(ft & 0x80)) continue;
        if (!withDeleted && ft === 0) continue;
        out.push({
          index, type: ft & 7, closed: !!(ft & 0x80), locked: !!(ft & 0x40),
          name: sec.slice(o + 5, o + 21), track: sec[o + 3], sector: sec[o + 4],
          blocks: sec[o + 30] | (sec[o + 31] << 8), dirTrack: t, dirSector: s, offset: o,
        });
      }
      [t, s] = [sec[0], sec[1]];
    }
    return out;
  }

  /** The first file whose name matches the pattern (wildcards * and ?). */
  find(pattern: Uint8Array, type?: number): DirEntry | null {
    for (const e of this.entries()) {
      if (e.type === 0 || !e.closed) continue; // deleted, or never closed (a "splat" file)
      if (type !== undefined && e.type !== type) continue;
      if (matches(pattern, e.name)) return e;
    }
    return null;
  }

  /** A file's bytes, following its chain of sectors. */
  read(e: DirEntry): Uint8Array {
    const out: number[] = [];
    let t = e.track, s = e.sector;
    const seen = new Set<number>();
    while (t) {
      if (seen.has(t * 256 + s)) throw new DiskError(66, 'ILLEGAL TRACK OR SECTOR', t, s);
      seen.add(t * 256 + s);
      const sec = this.sector(t, s);
      const [nt, ns] = [sec[0], sec[1]];
      const last = nt ? 255 : Math.max(1, ns);
      for (let i = 2; i <= last; i++) out.push(sec[i]);
      t = nt; s = ns;
    }
    return Uint8Array.from(out);
  }

  /** Writes a new file (type 1-3) and its directory entry. */
  write(name: Uint8Array, type: number, bytes: Uint8Array): void {
    const slot = this.freeEntry();
    const chain: [number, number][] = [];
    const count = Math.max(1, Math.ceil(bytes.length / 254));
    let pt = 0, ps = 0;
    for (let i = 0; i < count; i++) {
      const [t, s] = this.allocate(pt, ps);
      chain.push([t, s]);
      pt = t; ps = s;
    }
    chain.forEach(([t, s], i) => {
      const sec = this.sector(t, s);
      sec.fill(0);
      const part = bytes.subarray(i * 254, (i + 1) * 254);
      sec.set(part, 2);
      if (i + 1 < chain.length) { sec[0] = chain[i + 1][0]; sec[1] = chain[i + 1][1]; }
      else { sec[0] = 0; sec[1] = part.length + 1; }
    });
    const dir = this.sector(slot.dirTrack, slot.dirSector);
    const o = slot.offset;
    dir.fill(0, o + 2, o + 32);
    dir[o + 2] = 0x80 | type;
    dir[o + 3] = chain[0][0]; dir[o + 4] = chain[0][1];
    dir.fill(0xa0, o + 5, o + 21);
    dir.set(name.subarray(0, 16), o + 5);
    dir[o + 30] = count & 0xff; dir[o + 31] = count >> 8;
    this.dirty = true;
  }

  /** A free directory slot, adding a directory sector if the chain is full. */
  private freeEntry(): { dirTrack: number; dirSector: number; offset: number } {
    let t = DIR_TRACK, s = 1;
    for (;;) {
      const sec = this.sector(t, s);
      for (let e = 0; e < 8; e++) if ((sec[e * 32 + 2] & 0x87) === 0 || sec[e * 32 + 2] === 0) return { dirTrack: t, dirSector: s, offset: e * 32 };
      if (!sec[0]) {
        // A new directory sector on track 18, every third sector as the 1541 does.
        let ns = -1;
        for (let k = 1; k <= sectorsIn(DIR_TRACK); k++) {
          const c = (s + 3 * k) % sectorsIn(DIR_TRACK);
          if (this.isFree(DIR_TRACK, c)) { ns = c; break; }
        }
        if (ns < 0) throw new DiskError(72, 'DISK FULL');
        this.setFree(DIR_TRACK, ns, false);
        sec[0] = DIR_TRACK; sec[1] = ns;
        const fresh = this.sector(DIR_TRACK, ns);
        fresh.fill(0); fresh[1] = 0xff;
        return { dirTrack: DIR_TRACK, dirSector: ns, offset: 0 };
      }
      [t, s] = [sec[0], sec[1]];
    }
  }

  /** Scratches a file: frees its sectors and marks the entry deleted. */
  scratch(e: DirEntry): void {
    let t = e.track, s = e.sector;
    const seen = new Set<number>();
    while (t && !seen.has(t * 256 + s)) {
      seen.add(t * 256 + s);
      const sec = this.sector(t, s);
      this.setFree(t, s, true);
      [t, s] = [sec[0], sec[1]];
    }
    this.sector(e.dirTrack, e.dirSector)[e.offset + 2] = 0;
    this.dirty = true;
  }

  rename(e: DirEntry, name: Uint8Array): void {
    const dir = this.sector(e.dirTrack, e.dirSector);
    dir.fill(0xa0, e.offset + 5, e.offset + 21);
    dir.set(name.subarray(0, 16), e.offset + 5);
    this.dirty = true;
  }
}

/** The 1541's name match: `*` matches the rest, `?` any one character. */
export function matches(pattern: Uint8Array, name: Uint8Array): boolean {
  let i = 0;
  for (; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === 0x2a) return true;
    const c = i < 16 ? name[i] : 0xa0;
    if (p === 0x3f && c !== 0xa0) continue;
    if (p !== c) return false;
  }
  return i >= 16 || name[i] === 0xa0;
}

/** Text to a PETSCII name (letters plain). */
export function petsciiName(s: string): Uint8Array {
  return Uint8Array.from([...s.toUpperCase()].slice(0, 16).map(c => c.charCodeAt(0) & 0x7f));
}

/** A name for the screen: A0h padding dropped. */
export function nameString(raw: Uint8Array): string {
  let s = '';
  for (const b of raw) { if (b === 0xa0) break; s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?'; }
  return s;
}
