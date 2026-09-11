/**
 * The terms a file seller offers, and the arithmetic a buyer should check before agreeing.
 *
 * WHY THE UNIT IS BYTES AND NOT KIBIBYTES. `unitPriceSompi` must be at least 1, so pricing by the
 * byte puts a floor of 1 sompi per byte -- 0.01 KAS per mebibyte. A coarser unit would lift that
 * floor by a factor of a thousand and make bulk data cheap, and it was rejected anyway: a meter
 * that rounds up to a block lets a seller deliver a single byte and bill for the whole block. The
 * byte meter cannot do that, because one byte is exactly one unit. The price floor is a real
 * constraint on what is worth selling this way; a rounding meter would have been a hole in the
 * thing the protocol exists to prevent.
 */
import { minimumTolerance, resolveMeter, type OfferTerms } from 'metered';

export const UNIT = 'net.bytes_delivered.v1';
export const METER = 'octets';

/** 64 KiB. Large enough that per-babel overhead is noise, small enough to bound the exposure. */
export const DEFAULT_BABEL_BYTES = 64 * 1024;

export class UnsellableTerms extends Error {}

export interface TermsInput {
  network: string;
  sompiPerByte: number;
  babelBytes?: number;
  /** The largest file this seller will serve in one session, in bytes. */
  largestFileBytes: number;
  responseWindowDaa?: number;
  checkpointEvery?: number;
}

/**
 * Build the Offer terms for selling files by the byte.
 *
 * `maxBabels` is derived from the largest catalogue entry rather than picked: it has to be enough
 * to carry the biggest file to its last byte, because a session that runs out of babels mid-file
 * strands a buyer that has already paid for the earlier ones.
 */
export function fileTerms(input: TermsInput): OfferTerms {
  if (!Number.isSafeInteger(input.sompiPerByte) || input.sompiPerByte < 1) {
    throw new UnsellableTerms('price must be a whole number of sompi per byte, at least 1');
  }
  const babelUnits = input.babelBytes ?? DEFAULT_BABEL_BYTES;
  if (!Number.isSafeInteger(babelUnits) || babelUnits < 1) {
    throw new UnsellableTerms('babel size must be a whole number of bytes, at least 1');
  }

  const meter = resolveMeter(METER, UNIT);
  return {
    v: 1,
    scheme: 'metered',
    network: input.network,
    asset: 'KAS',
    unit: UNIT,
    meter: METER,
    unitPriceSompi: input.sompiPerByte,
    babelUnits,
    maxBabels: Math.max(1, Math.ceil(input.largestFileBytes / babelUnits)),
    // Zero, and it must be: the meter is exact, so there is no honest divergence for a tolerance
    // to absorb and any tolerance would be pure room to shave in.
    toleranceAbs: minimumTolerance(meter),
    checkpointEvery: input.checkpointEvery ?? 0,
    responseWindowDaa: input.responseWindowDaa ?? 600,
  };
}

/** Sompi for a whole file at these terms, so a buyer can decide before it opens a session. */
export const quote = (bytes: number, terms: OfferTerms): number => bytes * terms.unitPriceSompi;

/** Sompi as KAS, for printing only. Never used in an amount that is signed or settled. */
export const kas = (sompi: number): string => (sompi / 1e8).toFixed(8).replace(/0+$/, '0');
