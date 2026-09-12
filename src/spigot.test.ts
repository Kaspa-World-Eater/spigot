/**
 * What spigot promises, pinned.
 *
 * The protocol underneath has its own suite and is not re-tested here. These are the claims this
 * product makes on top of it: that the bytes that arrive are the bytes advertised, that a buyer
 * pays for exactly what it received and not a byte more, and that each of the three ways a seller
 * can be wrong is caught rather than absorbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { publicKeyHex, blake3Hex } from 'metered-protocol';
import { scan, lookup, costOf, NotForSale } from './catalogue.js';
import { decodeAsk, encodeAsk, MalformedAsk } from './ask.js';
import { serveSpigot, fileDeliver, AskPastTheEnd } from './seller.js';
import { download, readCatalogue, DigestMismatch, DeliveryFailed } from './buyer.js';
import { fileTerms, quote, unpayable, payableFrom, DUST_FLOOR_SOMPI, UnsellableTerms } from './terms.js';

const SELLER_SK = 'a1'.repeat(32);
const BUYER_SK = 'b2'.repeat(32);
const NETWORK = 'kaspa:testnet-10';

/** A directory with one text file and one file that is not text at all. */
function wares(): { root: string; text: Uint8Array; binary: Uint8Array } {
  const root = mkdtempSync(join(tmpdir(), 'spigot-test-'));
  const text = new TextEncoder().encode('# notes\ncafé 計量 🔒\n'.repeat(40));
  // Deliberately NOT valid UTF-8: lone continuation bytes, a NUL, a bare 0xFF. This is the case a
  // string-typed delivery path silently corrupts.
  const binary = new Uint8Array(5000);
  for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 37 + (i % 7) * 91) % 256;
  binary[0] = 0x89; binary[1] = 0x00; binary[2] = 0xff; binary[3] = 0x80;
  writeFileSync(join(root, 'notes.md'), text);
  writeFileSync(join(root, 'blob.bin'), binary);
  return { root, text, binary };
}

interface Shop { base: string; server: Server; root: string; items: ReturnType<typeof scan> }

async function shop(babelBytes = 1024, price = 1): Promise<Shop> {
  const { root } = wares();
  const items = scan(root);
  const terms = fileTerms({
    network: NETWORK, sompiPerByte: price, babelBytes,
    largestFileBytes: Math.max(...items.map((i) => i.bytes)),
  });
  const { server } = serveSpigot({
    root, items, terms, providerSk: SELLER_SK, providerPubkey: publicKeyHex(SELLER_SK),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, root, items };
}

const close = (s: Shop) => new Promise<void>((r) => s.server.close(() => r()));
const out = (name: string) => join(mkdtempSync(join(tmpdir(), 'spigot-out-')), name);

/* ------------------------------------------------------------------ the catalogue */

test('the catalogue describes every non-empty file, with the length that is also the bill', async () => {
  const s = await shop();
  try {
    const cat = await readCatalogue(s.base);
    assert.deepEqual(cat.items.map((i) => i.path).sort(), ['blob.bin', 'notes.md']);
    const blob = lookup(cat.items, 'blob.bin');
    assert.equal(blob.bytes, 5000);
    assert.equal(costOf(blob, cat.terms.unitPriceSompi), 5000, 'one sompi a byte, so the length IS the price');
  } finally {
    await close(s);
  }
});

test('the catalogue is the whole namespace -- nothing else is addressable', async () => {
  const s = await shop();
  try {
    // Not "refused after resolving": there is no resolution step at all, so a traversal attempt is
    // simply a name that is not in the catalogue.
    for (const attempt of ['../secret', '/etc/passwd', 'notes.md/../../x', 'nope.txt']) {
      assert.throws(() => lookup(s.items, attempt), NotForSale, attempt);
    }
  } finally {
    await close(s);
  }
});

/* -------------------------------------------------------------------- buying it */

test('A WHOLE FILE ARRIVES BYTE FOR BYTE, including bytes that are not text', async () => {
  const s = await shop(1024);
  try {
    const item = lookup(s.items, 'blob.bin');
    const dest = out('blob.bin');
    const { receipt } = await download(s.base, BUYER_SK, item, dest, NETWORK);

    const got = new Uint8Array(readFileSync(dest));
    const want = new Uint8Array(readFileSync(join(s.root, 'blob.bin')));
    assert.deepEqual(got, want, 'the delivered bytes are the seller\'s bytes');
    assert.equal(receipt.bytesReceived, 5000);
    assert.equal(receipt.sompiSpent, 5000, 'paid for exactly the bytes that arrived');
    assert.equal(receipt.babels, 5, '4 full babels of 1024 and a short final one');
  } finally {
    await close(s);
  }
});

test('THE LAST BABEL IS SHORT, and is billed short -- under-delivery is the ordinary case', async () => {
  const s = await shop(2048);
  try {
    const item = lookup(s.items, 'blob.bin');
    const { receipt } = await download(s.base, BUYER_SK, item, out('blob.bin'), NETWORK);
    // 5000 bytes in babels of 2048: two full, then 904. The buyer reserved 2048 for that last one
    // and paid for 904, which is the protocol's under-delivery rule arriving on every download
    // rather than on an exceptional one.
    assert.equal(receipt.babels, 3);
    assert.equal(receipt.sompiSpent, 5000, 'not 3 x 2048');
  } finally {
    await close(s);
  }
});

test('RESUMING COSTS ONLY THE REMAINDER, because the bytes already held were already paid for', async () => {
  const s = await shop(1024);
  try {
    const item = lookup(s.items, 'blob.bin');
    const dest = out('blob.bin');
    const whole = readFileSync(join(s.root, 'blob.bin'));
    writeFileSync(dest, whole.subarray(0, 3000));

    const { receipt } = await download(s.base, BUYER_SK, item, dest, NETWORK);
    assert.equal(receipt.bytesAlreadyHeld, 3000);
    assert.equal(receipt.bytesReceived, 2000);
    assert.equal(receipt.sompiSpent, 2000, 'paid for 2,000 bytes, not 5,000');
    assert.deepEqual(new Uint8Array(readFileSync(dest)), new Uint8Array(whole));
  } finally {
    await close(s);
  }
});

test('a file already longer than the catalogue says is refused, never silently truncated', async () => {
  const s = await shop();
  try {
    const item = lookup(s.items, 'blob.bin');
    const dest = out('blob.bin');
    writeFileSync(dest, Buffer.alloc(6000));
    await assert.rejects(() => download(s.base, BUYER_SK, item, dest, NETWORK), DeliveryFailed);
    assert.equal(statSync(dest).size, 6000, 'the buyer\'s own file was left alone');
  } finally {
    await close(s);
  }
});

/* ------------------------------------------------------- when the seller is wrong */

test('A SELLER THAT SENDS THE WRONG BYTES IS CAUGHT, even though every babel was agreed', async () => {
  // The seller and buyer agree perfectly on each babel -- same digest, same count, both signatures
  // valid -- and the assembled file is still not the advertised one. Only the catalogue digest can
  // see that, which is why it is the product's job rather than the protocol's.
  const { root } = wares();
  const items = scan(root);
  const lying = items.map((i) => (i.path === 'blob.bin' ? { ...i, digest: blake3Hex('something else') } : i));
  const terms = fileTerms({
    network: NETWORK, sompiPerByte: 1, babelBytes: 4096,
    largestFileBytes: Math.max(...items.map((i) => i.bytes)),
  });
  const { server } = serveSpigot({
    root, items: lying, terms, providerSk: SELLER_SK, providerPubkey: publicKeyHex(SELLER_SK),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const item = lookup(lying, 'blob.bin');
    await assert.rejects(() => download(base, BUYER_SK, item, out('blob.bin'), NETWORK), DigestMismatch);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the buyer refuses a seller on the wrong network before spending anything', async () => {
  const s = await shop();
  try {
    const item = lookup(s.items, 'notes.md');
    await assert.rejects(
      () => download(s.base, BUYER_SK, item, out('notes.md'), 'kaspa:mainnet'),
      /network/,
    );
  } finally {
    await close(s);
  }
});

/* ----------------------------------------------------------------- the ask itself */

test('an ask is validated, not trusted -- it is the one field a buyer controls freely', () => {
  assert.deepEqual(decodeAsk(encodeAsk({ path: 'a/b.bin', offset: 64 })), { path: 'a/b.bin', offset: 64 });
  for (const bad of ['', 'null', '[]', '{}', '{"path":"a"}', '{"path":"","offset":0}',
    '{"path":"a","offset":-1}', '{"path":"a","offset":1.5}', '{"path":"a","offset":"0"}']) {
    assert.throws(() => decodeAsk(bad), MalformedAsk, bad);
  }
});

test('an ask past the end of a file is refused rather than answered with nothing', () => {
  const { root } = wares();
  const items = scan(root);
  const deliver = fileDeliver(root, items);
  assert.equal(deliver(encodeAsk({ path: 'blob.bin', offset: 4999 }), 1024).length, 1, 'the last byte');
  assert.throws(() => deliver(encodeAsk({ path: 'blob.bin', offset: 5000 }), 1024), AskPastTheEnd);
});

test('a delivery never exceeds the babel it was reserved for', () => {
  const { root } = wares();
  const deliver = fileDeliver(root, scan(root));
  for (const max of [1, 7, 512, 4096, 99999]) {
    const got = deliver(encodeAsk({ path: 'blob.bin', offset: 0 }), max);
    assert.ok(got.length <= max, `${got.length} > ${max}`);
    assert.equal(got.length, Math.min(max, 5000));
  }
});

/* ----------------------------------------------------------------------- pricing */

test('terms must be sellable: a price below one sompi a byte cannot be expressed', () => {
  const base = { network: NETWORK, largestFileBytes: 5000 };
  assert.throws(() => fileTerms({ ...base, sompiPerByte: 0 }), UnsellableTerms);
  assert.throws(() => fileTerms({ ...base, sompiPerByte: 0.5 }), UnsellableTerms);
  assert.throws(() => fileTerms({ ...base, sompiPerByte: 1, babelBytes: 0 }), UnsellableTerms);
});

test('maxBabels is derived from the largest file, so no session runs out mid-download', () => {
  const terms = fileTerms({ network: NETWORK, sompiPerByte: 1, babelBytes: 1024, largestFileBytes: 5000 });
  assert.equal(terms.maxBabels, 5, 'ceil(5000 / 1024)');
  assert.equal(terms.toleranceAbs, 0, 'the meter is exact, so there is nothing to absorb');
  assert.equal(quote(5000, terms), 5000);
});

test('THE DUST FLOOR: a seller priced too low is worth less than a claim fee', () => {
  // On the kaspa-x402 rail a claim spends a fee and leaves a positive successor, so a total below
  // the floor is not worth claiming: the seller pays more to collect than it would receive. The
  // arithmetic is the same guard the old covenant enforced, now a claim-economics fact rather
  // than a settlement shape. A file must clear the floor to be worth selling by the byte.
  const terms = fileTerms({ network: NETWORK, sompiPerByte: 1, babelBytes: 65536, largestFileBytes: 200008 });
  const items = [{ path: 'small.bin', bytes: 200008 }, { path: 'big.bin', bytes: 3_000_000 }];

  assert.deepEqual(unpayable(items, terms).map((i) => i.path), ['small.bin']);
  assert.equal(payableFrom(terms), DUST_FLOOR_SOMPI, 'at 1 sompi/byte the floor IS the byte count');

  // Raising the price clears it, which is the other way out and the one the live re-run used:
  // the same file at 20 sompi/byte earned 4,000,160 and was paid as its own output.
  const richer = fileTerms({ network: NETWORK, sompiPerByte: 20, babelBytes: 65536, largestFileBytes: 200008 });
  assert.deepEqual(unpayable(items, richer), []);
  assert.equal(quote(200008, richer), 4000160);
});
