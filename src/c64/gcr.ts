/**
 * The disk surface as the 1541's head sees it: GCR bytes, one track at a
 * time, built from a .d64 and read back into it.
 *
 * Each sector is a sync (5 bytes of FFh), the header (08h, checksum,
 * sector, track, ID2, ID1, 0Fh, 0Fh: 8 bytes, 10 in GCR), a 9-byte gap of
 * 55h, a sync, the data block (07h, 256 bytes, checksum, 00h, 00h: 260
 * bytes, 325 in GCR) and a gap that fills the track out evenly. Track
 * lengths are those of a disk written at 300 rpm in its speed zone.
 */
import { sectorsIn, type D64 } from './disk';

/** 4 bits to 5: no more than two 0s in a row, so the clock never drifts. */
const TO_GCR = [0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17, 0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15];
const FROM_GCR = new Int8Array(32).fill(-1);
TO_GCR.forEach((g, n) => { FROM_GCR[g] = n; });

/** The speed zone a track is written in: 3 (fastest) on tracks 1-17 down to 0 from 31 on. */
export function speedZone(track: number): number {
  return track <= 17 ? 3 : track <= 24 ? 2 : track <= 30 ? 1 : 0;
}

/** Bytes on a track in each zone (the bit cell is 4, 3.75, 3.5 or 3.25 µs). */
const ZONE_BYTES = [6250, 6666, 7142, 7692];
export function trackBytes(track: number): number { return ZONE_BYTES[speedZone(track)]; }

/** Drive cycles (1 MHz) per byte in a zone. */
export function cyclesPerByte(zone: number): number { return 32 - 2 * zone; }

/** Encodes 4 bytes into 5 GCR bytes at `out[at]`. */
function encode4(b: ArrayLike<number>, i: number, out: Uint8Array, at: number): void {
  let bits = 0, n = 0, o = at;
  for (let k = 0; k < 4; k++) {
    const v = b[i + k];
    bits = (bits << 10) | (TO_GCR[v >> 4] << 5) | TO_GCR[v & 15];
    n += 10;
    while (n >= 8) { n -= 8; out[o++] = (bits >> n) & 0xff; }
  }
}

/** Decodes 5 GCR bytes into 4; null on a code that is not GCR. */
function decode5(g: Uint8Array, at: number, out: Uint8Array, o: number): boolean {
  // 40 bits as two halves: the first 20 bits and the last 20.
  const hi = (g[at] << 12) | (g[at + 1] << 4) | (g[at + 2] >> 4);
  const lo = ((g[at + 2] & 15) << 16) | (g[at + 3] << 8) | g[at + 4];
  for (const [w, k] of [[hi, 0], [lo, 2]]) {
    const a = FROM_GCR[(w >> 15) & 31], b = FROM_GCR[(w >> 10) & 31];
    const c = FROM_GCR[(w >> 5) & 31], d = FROM_GCR[w & 31];
    if (a < 0 || b < 0 || c < 0 || d < 0) return false;
    out[o + k] = (a << 4) | b;
    out[o + k + 1] = (c << 4) | d;
  }
  return true;
}

function encodeBlock(bytes: number[], out: Uint8Array, at: number): number {
  for (let i = 0; i < bytes.length; i += 4) { encode4(bytes, i, out, at); at += 5; }
  return at;
}

/** One track of a .d64 in GCR. */
export function encodeTrack(d: D64, track: number): Uint8Array {
  const out = new Uint8Array(trackBytes(track)).fill(0x55);
  const n = sectorsIn(track);
  const bam = d.sector(18, 0);
  const id1 = bam[0xa2], id2 = bam[0xa3];
  const gap = Math.floor((out.length - n * 354) / n);
  let at = 0;
  for (let s = 0; s < n; s++) {
    out.fill(0xff, at, at + 5); at += 5;
    at = encodeBlock([0x08, s ^ track ^ id2 ^ id1, s, track, id2, id1, 0x0f, 0x0f], out, at);
    at += 9;
    out.fill(0xff, at, at + 5); at += 5;
    const data = d.sector(track, s);
    let sum = 0;
    for (const b of data) sum ^= b;
    at = encodeBlock([0x07, ...data, sum, 0, 0], out, at);
    at += gap;
  }
  return out;
}

/** The whole disk: index = track (1-42); tracks past the disk's are empty. */
export function encodeDisk(d: D64): Uint8Array[] {
  const t: Uint8Array[] = [new Uint8Array(0)];
  for (let tr = 1; tr <= 42; tr++) t.push(tr <= d.tracks ? encodeTrack(d, tr) : new Uint8Array(trackBytes(tr)));
  return t;
}

/**
 * Reads every sector found on the GCR tracks back into the .d64 (what the
 * drive wrote). Returns the number of sectors whose data changed.
 */
export function decodeDisk(tracks: Uint8Array[], d: D64): number {
  let changed = 0;
  for (let tr = 1; tr <= d.tracks; tr++) {
    const raw = tracks[tr];
    if (!raw?.length) continue;
    // The track twice over, so a block that runs past the end reads on.
    const g = new Uint8Array(raw.length + 400);
    g.set(raw); g.set(raw.subarray(0, 400), raw.length);
    const head = new Uint8Array(8), block = new Uint8Array(260);
    let sector = -1;
    for (let i = 1; i < raw.length; i++) {
      // A sync is a run of FFh; the block starts on the first byte after it.
      if (g[i - 1] !== 0xff || g[i] === 0xff) continue;
      if (decode5(g, i, head, 0) && head[0] === 0x08 && decode5(g, i + 5, head, 4)) {
        sector = head[3] === tr && head[2] < sectorsIn(tr) ? head[2] : -1;
        continue;
      }
      if (sector < 0) continue;
      let ok = true;
      for (let k = 0; k < 65 && ok; k++) ok = decode5(g, i + k * 5, block, k * 4);
      if (ok && block[0] === 0x07) {
        const dst = d.sector(tr, sector);
        let same = true;
        for (let k = 0; k < 256; k++) if (dst[k] !== block[k + 1]) { same = false; break; }
        if (!same) { dst.set(block.subarray(1, 257)); changed++; }
      }
      sector = -1;
    }
  }
  if (changed) d.dirty = true;
  return changed;
}
