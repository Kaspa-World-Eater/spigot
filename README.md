# spigot

**Sell files by the byte. The buyer pays for the bytes that arrived, and counts them itself.**

**→ [Read what spigot is, in one page](https://kaspahttp402.github.io/spigot/)** — the idea, how a purchase works, and why the seller cannot overstate what it sent.

Every way of selling a download today bills you for what the server says it sent. If the transfer
stalls at 60%, the bill is a conversation. `spigot` removes the conversation: the buyer authorises
one slice at a time, both sides count every byte independently, and the money follows the bytes
that actually landed.

```bash
# seller
spigot serve ./wares --price 20

# buyer
spigot channel open http://seller:8402 --escrow 0.5   # once, per seller
spigot get http://seller:8402 dataset.tar.zst --pay   # bills the channel
spigot refund <covenantId>                            # reclaim the rest, after the timeout

# seller
spigot claim <covenantId>                             # collect what the vouchers cover
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
| `src/terms.ts` | the Offer terms, the dust floor, and why the unit is bytes |
| `src/settle.ts` | fund a covenant, post the agreed State, pay everyone out |
| `src/keys.ts` | the two identities — which are also the two wallets |
| `bin/spigot.ts` | `serve`, `catalogue`, `get`, `address` |

```bash
npm install
npm test
```

## The dust floor, which decides what is worth selling

Kaspa's KIP-9 storage-mass rule will not carry a very small transaction output. If a seller's
earnings for a whole file come to less than **2,600,000 sompi**, the covenant folds them into the
buyer's refund rather than demanding an output consensus cannot create — the download works, both
sides agree the bill, the close is valid, and **the seller is paid nothing**.

That is not a theory. Selling a 200,008-byte file at one sompi a byte settled and closed on
testnet-10 with a single output, and the whole earning went back to the buyer. `spigot serve` now
says so up front, and names the size a file must reach at your price.

Two ways out: price higher, or sell bigger files. At 1 sompi/byte a file clears the floor from
about 2.6 MB; at 20 sompi/byte, from 130 KB.

## Settlement: the kaspa-x402 rail

spigot does not hold its own escrow. It settles through the **kaspa-x402** reference
implementation's `batch-settlement` channel ([kaspa-x402.org](https://kaspa-x402.org)) via
[metered-protocol](https://github.com/kaspahttp402/metered-protocol)'s rail.

A buyer opens one escrow **channel** with a seller, then buys any number of files against it. After
each babel the buyer signs a *voucher* for the agreed cumulative total, which travels with its
countersignature — so the seller is never owed for a slice it has not been paid for. The seller
claims what the vouchers cover whenever it likes; the buyer refunds the remainder after the
channel's timeout. metered decides each bill by two-sided count; the rail pays it.

## Status

Runs end to end on testnet-10, through the kaspa-x402 escrow (2026-09-22; every id links to the
explorer, and `docs/proofs/<txid>.json` holds the transaction itself, written the moment the node
accepted it):

- A buyer opened a **0.2 KAS channel** (genesis [`ab37363250487bc145c5aa21b3ba405941824cf684eb94587593388e4a326945`](https://explorer-tn10.kaspa.org/txs/ab37363250487bc145c5aa21b3ba405941824cf684eb94587593388e4a326945),
  covenantId `9952c222f1deab59e7a652c8e9bfd7cb80bf20ea2e3173ecc10f5589f4f21a69`), bought a **200,008-byte** file
  billed to it in 4 babels for **0.04000160 KAS**, delivered byte-identical to the source.
- Every babel was **vouchered with its countersignature**; the seller **claimed**
  [`25f8e5893212819299f3a38a5abc5fa75e9a974c871fcb366b8c6d1323f29ef8`](https://explorer-tn10.kaspa.org/txs/25f8e5893212819299f3a38a5abc5fa75e9a974c871fcb366b8c6d1323f29ef8),
  taking 0.03500160 KAS (the bill less the 0.005 claim fee) with **0.1599984 KAS left in the channel**.
- After the channel's timeout the buyer **refunded** the remainder:
  [`59396e51eeb1fd440608467a33c14d873c60e3b53a433808386b882be2bb9e2d`](https://explorer-tn10.kaspa.org/txs/59396e51eeb1fd440608467a33c14d873c60e3b53a433808386b882be2bb9e2d),
  0.1549984 KAS back (the remainder less the refund fee).
- A seller that under-delivered **cannot** claim the reservation: refused by the builder, the
  accounting, and the escrow script.

An earlier run (2026-09-11) proved the same thing, but its ids no longer resolve on the public
testnet-10 index, and an id nobody can fetch is not a proof. That is why the proofs are archived now.

Not on mainnet, deliberately: the kaspa-x402 escrow is alpha and unaudited for mainnet funds.

## Licence

MIT.
