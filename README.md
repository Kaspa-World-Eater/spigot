# spigot

**Sell files by the byte. The buyer pays for the bytes that arrived, and counts them itself.**

Every way of selling a download today bills you for what the server says it sent. If the transfer
stalls at 60%, the bill is a conversation. `spigot` removes the conversation: the buyer authorises
one slice at a time, both sides count every byte independently, and the money follows the bytes
that actually landed.

```bash
# seller
spigot serve ./wares --price 1

# buyer
spigot catalogue http://seller:8402
spigot get http://seller:8402 dataset.tar.zst --out ./dataset.tar.zst
```

It is built on [metered](https://github.com/kaspahttp402/metered-protocol), a payment protocol for
work whose size is only known once it has been delivered, settled on Kaspa.

---

## What makes this different

**A stalled download costs you nothing for what never arrived.** Not a refund, not a dispute — the
bytes were never billed. Each slice is reserved, delivered, counted by both parties and agreed
before the next one is authorised.

**Resuming is not a feature.** An interrupted download is just a download whose next request starts
further in. Nothing is negotiated and nothing is refunded, because nothing was overpaid.

**The seller cannot overstate what it sent.** The unit is `net.bytes_delivered.v1`, metered by
`octets`, and that meter is *exact*: both sides agree on the content digest before any count is
consulted, so two honest parties cannot disagree about a length. The tolerance is **zero** — there
is no rounding, and therefore no room to shave.

**The seller cannot substitute the file, either.** The catalogue advertises a digest of the whole
file. The buyer checks what it assembled against that digest after the last byte. Every individual
slice can be perfectly agreed and the assembled file still be the wrong one — that check is this
program's job, not the protocol's.

## How a download works

1. The buyer reads the **catalogue** — path, length, digest, price. Unpaid, because you cannot
   decide to buy something you cannot see.
2. It opens a metered session and authorises one **babel** — by default 64 KiB.
3. The seller returns that byte range and its own count of it. The buyer counts the same bytes and
   signs its own figure. If the two disagree, the session stops.
4. Repeat from the buyer's own offset until the file is whole. **The last slice is short**, and is
   billed short.
5. The buyer digests the assembled file and checks it against the catalogue.

The request is complete in itself — a path and an offset — so the seller holds no cursor. There is
no per-buyer position that could drift out of step with the buyer's own.

## Pricing, honestly

Price is **sompi per byte**, and the protocol requires it to be at least 1. That puts a floor of
**0.01 KAS per mebibyte**, which suits files that are worth something per byte — datasets, model
weights, paid archives, research data — and does not suit bulk traffic.

A coarser unit (per KiB, say) would drop that floor a thousandfold, and was rejected: a meter that
rounds up to a block lets a seller deliver one byte and bill for the whole block. The byte meter
cannot, because one byte is exactly one unit. The price floor is a real limit; a rounding meter
would have been a hole in the one thing this is for.

## What is here

| | |
|---|---|
| `src/catalogue.ts` | what is for sale: path, length, digest |
| `src/ask.ts` | the request grammar — a path and an offset, validated not trusted |
| `src/seller.ts` | the `Deliver` that serves byte ranges, and the HTTP server |
| `src/buyer.ts` | pull babels until whole, then check the digest |
| `src/terms.ts` | the Offer terms, and why the unit is bytes |
| `bin/spigot.ts` | `serve`, `catalogue`, `get` |

```bash
npm install
npm test
```

## Status

The delivery half runs end to end: a real catalogue, real byte ranges, both sides counting, mutual
signatures on every slice, and a verified digest at the end. Proven on a 200 KB binary file
delivered in 4 babels for exactly 200,008 sompi, byte-identical to the source, and on a resumed
download that paid only for its remaining 130,008 bytes.

**On-chain settlement is not yet wired in.** A session produces a signed final State that the
metered covenant is built to settle; connecting that is the next piece. Until then the accounting
is complete and mutually signed, but nothing has moved on chain.

## Licence

MIT.
