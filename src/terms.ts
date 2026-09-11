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

/**
 * The smallest payout Kaspa will carry as its own output.
 *
 * KIP-9 prices a transaction by storage mass, `10^12/out1 + 10^12/out2 - 10^12/in`, and a small
 * output costs more mass than the 500,000 limit permits. The covenant's answer is to fold a payout
 * this small into the other party's output rather than demand one consensus cannot create -- so
 * the money is not lost, but it goes to the BUYER. The seller delivered the bytes and earned
 * nothing.
 *
 * Measured, not chosen: proven on testnet-10 by selling a 200,008-byte file at one sompi a byte
 * and watching the whole earning fold into the refund.
 */
export const DUST_FLOOR_SOMPI = 2_600_000;

/**
 * The catalogue entries a seller cannot actually be paid for at this price.
 *
 * Worth saying out loud at `serve` time, because the failure is silent and asymmetric: the
 * download works, both sides agree the bill, the close is valid, and the seller is simply not
 * paid. At one sompi a byte a file must be about 2.6 MB before it clears the floor.
 */
export const unpayable = (items: { path: string; bytes: number }[], terms: OfferTerms) =>
  items.filter((i) => quote(i.bytes, terms) < DUST_FLOOR_SOMPI);

/** The smallest file worth selling at this price, in bytes. */
export const payableFrom = (terms: OfferTerms): number =>
  Math.ceil(DUST_FLOOR_SOMPI / terms.unitPriceSompi);
