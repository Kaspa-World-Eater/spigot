/**
 * The buying half: pull babels until the file is whole, counting every byte independently.
 *
 * The buyer never takes the seller's word for anything. metered already makes it count each babel
 * and refuse to sign a figure it did not measure; this file adds the one check that belongs to the
 * application rather than the protocol -- that the bytes assembled at the end are the bytes the
 * catalogue advertised.
 *
 * RESUMING IS NOT A FEATURE HERE, IT IS THE ABSENCE OF ONE. Because an ask carries its own offset
 * (see ask.ts) and the protocol bills for what arrived rather than what was reserved, a download
 * that stopped halfway is simply a download whose next ask starts further in. Nothing is
 * negotiated, nothing is refunded, and the bytes that never arrived were never paid for.
 */
import { appendFileSync, existsSync, statSync, readFileSync, truncateSync } from 'node:fs';
import { openSession, runBabel, blake3Hex, meterFor, type BuyerSession, type Offer, type State } from 'metered';
import { encodeAsk } from './ask.js';
import type { Item } from './catalogue.js';
import { CATALOGUE_PATH } from './seller.js';

export class DeliveryFailed extends Error {}
export class DigestMismatch extends Error {}

export interface Catalogue {
  items: Item[];
  terms: {
    unit: string; meter: string; unitPriceSompi: number; babelUnits: number;
    network: string; responseWindowDaa: number;
  };
}

export interface Receipt {
  path: string;
  bytesReceived: number;
  bytesAlreadyHeld: number;
  sompiSpent: number;
  babels: number;
  digest: string;
  /** The last agreed State and both signatures over it -- everything settlement needs. */
  settlement: { state: State; providerSig: string; buyerSig: string } | null;
}

/** Read what a seller has for sale. Unpaid, because deciding to buy requires seeing the price. */
export async function readCatalogue(base: string): Promise<Catalogue> {
  const res = await fetch(`${base}${CATALOGUE_PATH}`);
  if (!res.ok) throw new DeliveryFailed(`catalogue unavailable: HTTP ${res.status}`);
  return await res.json() as Catalogue;
}

/** How far into this file the buyer already is. A partial file is a starting offset, not a problem. */
function resumeFrom(out: string, item: Item): number {
  if (!existsSync(out)) return 0;
  const held = statSync(out).size;
  if (held > item.bytes) {
    // More bytes than the catalogue advertises means this is not a prefix of the file being
    // bought. Truncating silently could destroy something unrelated that happens to share a name.
    throw new DeliveryFailed(`${out} already holds ${held} bytes, more than the ${item.bytes} advertised`);
  }
  return held;
}

/**
 * Buy one file, one babel at a time.
 *
 * The loop's only exit conditions are "the file is complete" and "a babel arrived empty". There is
 * no retry: a seller that stops sending has stopped earning, and the buyer keeps both the bytes it
 * paid for and the right to ask again later.
 */
export async function download(
  base: string,
  buyerSk: string,
  item: Item,
  out: string,
  expectedNetwork?: string,
  /**
   * Run once, after the Offer exists and before the first babel.
   *
   * THE ORDER IS FORCED. A covenant's address is derived from the Offer's own session id, so it
   * cannot be funded before the session is opened -- and a seller has no reason to deliver against
   * funds that are not yet there. Anything that wants to pay on chain hooks in here.
   */
  afterOpen?: (offer: Offer) => Promise<void>,
): Promise<{ receipt: Receipt; session: BuyerSession; offer: Offer }> {
  const cat = await readCatalogue(base);
  const meter = meterFor(cat.terms.meter, cat.terms.unit);
  const { offer, session } = await openSession(base, buyerSk, meter, expectedNetwork);
  if (afterOpen) await afterOpen(offer);

  const start = resumeFrom(out, item);
  let offset = start;
  let babels = 0;
  let last: { state: State; providerSig: string; buyerSig: string } | null = null;

  while (offset < item.bytes) {
    const outcome = await runBabel(base, session, encodeAsk({ path: item.path, offset }));
    if (outcome.content.length === 0) {
      throw new DeliveryFailed(`the seller sent nothing at offset ${offset} of ${item.bytes}`);
    }
    appendFileSync(out, outcome.content);
    offset += outcome.content.length;
    babels += 1;
    last = { state: outcome.state, providerSig: outcome.providerSig, buyerSig: outcome.buyerSig };
  }

  // THE CHECK THE PROTOCOL CANNOT MAKE. metered proves each babel is the bytes both sides agreed
  // on; only the catalogue knows whether those babels, in that order, are the advertised file.
  const digest = blake3Hex(new Uint8Array(readFileSync(out)));
  if (digest !== item.digest) {
    // Leave the bytes on disk under a rejected name rather than deleting them: the buyer paid for
    // them, and what arrived is evidence about which side is wrong.
    throw new DigestMismatch(
      `assembled ${offset} bytes of ${item.path} but the digest is ${digest}, not the advertised ${item.digest}`,
    );
  }

  return {
    receipt: {
      path: item.path,
      bytesReceived: offset - start,
      bytesAlreadyHeld: start,
      sompiSpent: session.spentSompi,
      babels,
      digest,
      settlement: last,
    },
    session,
    offer,
  };
}

/** Discard a partial download. Separate from `download`, so nothing deletes bytes on its own. */
export function discard(out: string): void {
  if (existsSync(out)) truncateSync(out, 0);
}
