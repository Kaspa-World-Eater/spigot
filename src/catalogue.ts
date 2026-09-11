/**
 * What is for sale, and the two facts a buyer needs before it spends anything.
 *
 * A catalogue entry is a path, a length, and a digest of the whole file. The length is what lets a
 * buyer work out the bill before agreeing to it; the digest is what lets it prove, after the last
 * byte, that what it assembled is what was advertised.
 *
 * THE CATALOGUE IS THE ENTIRE NAMESPACE. A request names an entry by its exact catalogue key and
 * nothing else is reachable -- there is no path to resolve, so there is no path traversal to
 * defend against. A seller that wants a file sold puts it in the catalogue; everything else on the
 * disk is not addressable, rather than being addressable and refused.
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { blake3Hex } from 'metered-protocol';

export interface Item {
  /** The catalogue key, and the only name a buyer may use. Always forward-slashed. */
  path: string;
  /** Length in bytes. This is the unit, so this is also the bill. */
  bytes: number;
  /** blake3 of the whole file, for the buyer's check after the last babel. */
  digest: string;
}

export class NotForSale extends Error {}

/** Read a file in bounded pieces, so cataloguing a large file does not hold it all in memory. */
const DIGEST_CHUNK = 1024 * 1024;

function digestOf(absolute: string, bytes: number): string {
  // blake3Hex takes the whole input, so this still materialises the file to hash it. Bounded
  // reading here would need a streaming hasher, which the protocol does not expose -- noted
  // because it is a real ceiling on catalogue size, not because it bites at the sizes below.
  const fd = openSync(absolute, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    let read = 0;
    while (read < bytes) {
      const n = readSync(fd, buf, read, Math.min(DIGEST_CHUNK, bytes - read), read);
      if (n <= 0) break;
      read += n;
    }
    return blake3Hex(new Uint8Array(buf.buffer, buf.byteOffset, read));
  } finally {
    closeSync(fd);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Scan a directory into a catalogue.
 *
 * Empty files are excluded rather than listed at zero bytes: a babel of nothing is a session that
 * can never advance, and the protocol's own floor is that a reservation must be for at least one
 * unit. A file with nothing in it is not a thing that can be sold by the byte.
 */
export function scan(root: string): Item[] {
  return walk(root)
    .map((absolute) => ({ absolute, bytes: statSync(absolute).size }))
    .filter(({ bytes }) => bytes > 0)
    .map(({ absolute, bytes }) => ({
      path: relative(root, absolute).split(sep).join('/'),
      bytes,
      digest: digestOf(absolute, bytes),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The entry a request names, or refuse. Nothing outside the catalogue is reachable. */
export function lookup(items: Item[], path: string): Item {
  const found = items.find((i) => i.path === path);
  if (!found) throw new NotForSale(`nothing in this catalogue is called ${JSON.stringify(path)}`);
  return found;
}

/** What a whole file costs at a given price. The buyer can compute this before it agrees to it. */
export const costOf = (item: Item, sompiPerByte: number): number => item.bytes * sompiPerByte;
