/**
 * `spigot` -- sell files by the byte, or buy them.
 *
 *   spigot serve <dir> [--price N] [--port N] [--babel N]
 *   spigot catalogue <url>
 *   spigot get <url> <path> [--out FILE]
 *
 * Three commands, because there are three things a person does: offer some files, look at what
 * someone is offering, and buy one. Everything about payment is in the protocol underneath.
 */
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { scan, lookup, type Item } from '../src/catalogue.js';
import { serveSpigot, CATALOGUE_PATH } from '../src/seller.js';
import { download, readCatalogue } from '../src/buyer.js';
import { fileTerms, quote, kas, unpayable, payableFrom, DUST_FLOOR_SOMPI } from '../src/terms.js';
import { identity } from '../src/keys.js';
import { openAndFund, settleAndClose, fundingFor } from '../src/settle.js';
import type { Offer } from 'metered-protocol';

const argv = process.argv.slice(2);
const [command, ...rest] = argv;

const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1] ?? fallback;
};
const num = (name: string, fallback: number): number => Number(flag(name, String(fallback)));
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));

const NETWORK = flag('network', 'kaspa:testnet-10');

function usage(): never {
  console.log(`
  spigot -- pay-per-byte file delivery, metered by both sides

    spigot serve <dir> [--price N] [--port N] [--babel N] [--network ID]
        Offer every file under <dir>. --price is sompi per byte (default 1).

    spigot catalogue <url>
        List what a seller is offering, and what each file would cost.

    spigot get <url> <path> [--out FILE] [--settle] [--network ID]
        Buy one file, one babel at a time, counting every byte.
        --settle funds a covenant first and pays the seller on chain at the end.

    spigot address [--role buyer|seller] [--network ID]
        The Kaspa address this key is paid to. Fund the buyer's before --settle.
`);
  process.exit(1);
}

/** ------------------------------------------------------------------ serve */
async function serve(): Promise<void> {
  const dir = positional[0];
  if (!dir) usage();
  const root = resolve(dir);
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);

  const items = scan(root);
  if (items.length === 0) throw new Error(`${root} holds no non-empty files to sell`);

  const price = num('price', 1);
  const me = identity('seller');
  const terms = fileTerms({
    network: NETWORK,
    sompiPerByte: price,
    babelBytes: num('babel', 64 * 1024),
    largestFileBytes: Math.max(...items.map((i) => i.bytes)),
    // The covenant is compiled with this window and `expire` enforces it, so the number the terms
    // advertise and the number consensus checks are necessarily the same one.
    responseWindowDaa: num('window', 600),
  });

  const { server } = serveSpigot({
    root, items, terms, providerSk: me.secretKeyHex, providerPubkey: me.publicKeyHex,
  });

  await new Promise<void>((r) => server.listen(num('port', 8402), '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  console.log(`\n  spigot serving ${items.length} file(s) from ${root}`);
  console.log(`  seller ${me.publicKeyHex.slice(0, 16)}...  (${me.file})`);
  console.log(`  ${price} sompi/byte, ${terms.babelUnits} bytes per babel, tolerance ${terms.toleranceAbs}\n`);
  for (const i of items) console.log(`    ${pad(i.path, 44)} ${pad(String(i.bytes), 12)} ${kas(quote(i.bytes, terms))} KAS`);
  const unpaid = unpayable(items, terms);
  if (unpaid.length) {
    console.log(`\n  ${unpaid.length} of these earn less than the ${DUST_FLOOR_SOMPI} sompi KIP-9 requires for`);
    console.log(`  an output of their own, so the covenant folds that earning into the BUYER's refund`);
    console.log(`  and you are paid nothing. At ${price} sompi/byte a file clears it from ${payableFrom(terms)} bytes.`);
  }
  console.log(`\n  http://127.0.0.1:${port}${CATALOGUE_PATH}\n`);
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** -------------------------------------------------------------- catalogue */
async function catalogue(): Promise<void> {
  const base = positional[0];
  if (!base) usage();
  const cat = await readCatalogue(base);
  console.log(`\n  ${cat.items.length} file(s), ${cat.terms.unitPriceSompi} sompi per byte, ${cat.terms.network}\n`);
  for (const i of cat.items) {
    console.log(`    ${pad(i.path, 44)} ${pad(String(i.bytes), 12)} ${kas(i.bytes * cat.terms.unitPriceSompi)} KAS`);
    console.log(`    ${pad('', 44)} ${i.digest}`);
  }
  console.log('');
}

/** -------------------------------------------------------------------- get */
async function get(): Promise<void> {
  const [base, path] = positional;
  if (!base || !path) usage();

  const cat = await readCatalogue(base);
  const item: Item = lookup(cat.items, path);
  const out = resolve(flag('out', basename(path)));
  const settling = argv.includes('--settle');

  console.log(`
  ${item.path}  ${item.bytes} bytes  ->  ${out}`);
  console.log(`  quoted ${kas(item.bytes * cat.terms.unitPriceSompi)} KAS at ${cat.terms.unitPriceSompi} sompi/byte`);

  const me = identity('buyer');
  let chain: Awaited<ReturnType<typeof openAndFund>> | null = null;

  const { receipt, offer } = await download(base, me.secretKeyHex, item, out, cat.terms.network, async (o: Offer) => {
    if (!settling) return;
    console.log(`  funding a covenant with ${kas(Number(fundingFor(o)))} KAS ...`);
    chain = await openAndFund(o, me.secretKeyHex, network(cat), cat.terms.responseWindowDaa);
    console.log(`  covenant   ${chain.opened.address.slice(0, 34)}...`);
  });

  console.log(`
  ${receipt.babels} babel(s), ${receipt.bytesReceived} bytes received` +
    (receipt.bytesAlreadyHeld ? `, ${receipt.bytesAlreadyHeld} already held` : ''));
  console.log(`  owed ${receipt.sompiSpent} sompi (${kas(receipt.sompiSpent)} KAS)`);
  console.log(`  digest matches the catalogue: ${receipt.digest.slice(0, 24)}...`);

  if (!chain) {
    console.log('\n  not settled on chain. The State is signed by both sides; run with --settle to pay it.\n');
    return;
  }
  if (!receipt.settlement) throw new Error('nothing was delivered, so there is nothing to settle');

  console.log('\n  settling ...');
  const paid = await settleAndClose(chain, {
    offer,
    state: receipt.settlement.state,
    buyerSk: me.secretKeyHex,
    providerSig: receipt.settlement.providerSig,
    network: network(cat),
    window: cat.terms.responseWindowDaa,
  });
  console.log(`  settled    ${paid.settleTxid}`);
  console.log(`  closed     ${paid.closeTxid}`);
  for (const o of paid.outputs) console.log(`    ${kas(Number(o.amount))} KAS -> ${o.address.slice(0, 34)}...`);
  console.log('');
}

/** `kaspa:testnet-10` is how the protocol names a network; the SDK wants `testnet-10`. */
const network = (cat: { terms: { network: string } }) =>
  cat.terms.network.replace(/^kaspa:/, '') as 'testnet-10' | 'testnet-11' | 'mainnet';

/** ---------------------------------------------------------------- address */
async function address(): Promise<void> {
  const me = identity(flag('role', 'buyer') === 'seller' ? 'seller' : 'buyer');
  const { loadSdk } = await import('metered-protocol/chain');
  const sdk = await loadSdk() as { PrivateKey: new (k: string) => { toKeypair: () => { toAddress: (n: unknown) => { toString: () => string } } }; NetworkId: new (n: string) => unknown };
  const net = new sdk.NetworkId(NETWORK.replace(/^kaspa:/, ''));
  console.log(`
  ${new sdk.PrivateKey(me.secretKeyHex).toKeypair().toAddress(net).toString()}
  key: ${me.file}
`);
}

const COMMANDS: Record<string, () => Promise<void>> = { serve, catalogue, get, address };

const run = COMMANDS[command ?? ''];
if (!run) usage();
run().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
