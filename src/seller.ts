/**
 * The selling half: a `Deliver` that hands back byte ranges of real files.
 *
 * This is the entire application-specific part of the seller. Everything else -- the 402, the
 * reservation, the two counts, the signatures, the halt on disagreement -- belongs to metered and
 * is not reimplemented or adjusted here. That is the claim being tested by building this at all:
 * that selling a new kind of thing means writing a `Deliver` and nothing more.
 *
 * THE LAST BABEL OF A FILE IS SHORT, AND THAT IS NOT AN ERROR. A buyer reserves a whole babel and
 * receives whatever is left, which the protocol already handles correctly: under-delivery bills
 * for what arrived rather than for what was reserved. A file-delivery product gets that behaviour
 * for free on every single download, in the ordinary case, not the exceptional one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { MeteredService, meteredHandler, meterFor, type Deliver, type OfferTerms, type ServiceOptions } from 'metered-protocol';
import { decodeAsk } from './ask.js';
import { lookup, type Item } from './catalogue.js';

export class AskPastTheEnd extends Error {}

/** The catalogue route. Unpaid on purpose: you cannot decide to buy something you cannot see. */
export const CATALOGUE_PATH = '/spigot/catalogue';

/**
 * Serve byte ranges out of a catalogue.
 *
 * READS ARE SYNCHRONOUS because metered's `Deliver` is, and metered's `Deliver` is synchronous
 * because reconciliation is. Each call reads at most one babel, so the block is bounded by the
 * babel size rather than by the file size -- but it is a real block, and a seller seeing many
 * concurrent buyers would feel it. Recorded here rather than hidden: this is the second time this
 * signature has forced a workaround, the first being metered's own model adapter, which had to
 * fetch every completion up front.
 */
export function fileDeliver(root: string, items: Item[]): Deliver {
  return (prompt: string, maxUnits: number): Uint8Array => {
    const ask = decodeAsk(prompt);
    const item = lookup(items, ask.path);
    if (ask.offset >= item.bytes) {
      throw new AskPastTheEnd(`${item.path} is ${item.bytes} bytes; asked from ${ask.offset}`);
    }

    const want = Math.min(maxUnits, item.bytes - ask.offset);
    const buf = Buffer.allocUnsafe(want);
    const fd = openSync(join(root, ...item.path.split('/')), 'r');
    try {
      let read = 0;
      // A short read is not the end of the file here -- `want` is already clamped to what exists,
      // so looping until it is satisfied is the correct response to a partial read.
      while (read < want) {
        const n = readSync(fd, buf, read, want - read, ask.offset + read);
        if (n <= 0) break;
        read += n;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, read);
    } finally {
      closeSync(fd);
    }
  };
}

export interface SpigotOptions {
  root: string;
  items: Item[];
  terms: OfferTerms;
  providerSk: string;
  providerPubkey: string;
  /** How to verify a channel a buyer proposes (SPEC.md 3.5). Absent, no channel is billed against. */
  channelFor?: ServiceOptions['channelFor'];
  /** Where sessions -- and the vouchers they hold -- survive a restart. Absent, they do not. */
  sessions?: ServiceOptions['sessions'];
}

/**
 * An HTTP server that publishes a catalogue and sells what is in it.
 *
 * The catalogue is answered here and everything else is handed to metered untouched, so this file
 * adds exactly one route to the protocol's own.
 */
export function serveSpigot(opts: SpigotOptions): { server: Server; service: MeteredService } {
  const service = new MeteredService({
    terms: opts.terms,
    providerSk: opts.providerSk,
    providerPubkey: opts.providerPubkey,
    meter: meterFor(opts.terms.meter, opts.terms.unit),
    deliver: fileDeliver(opts.root, opts.items),
    ...(opts.channelFor ? { channelFor: opts.channelFor } : {}),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
  });

  const metered = meteredHandler({ service });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url ?? '') === CATALOGUE_PATH) {
      // The seller's key is in the catalogue so a buyer can open a channel with it BEFORE any
      // session exists -- the channel is the buyer's money, and it is the buyer that opens it.
      const body = JSON.stringify({ items: opts.items, terms: opts.terms, sellerPubkey: opts.providerPubkey });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    void metered(req, res);
  });

  return { server, service };
}
