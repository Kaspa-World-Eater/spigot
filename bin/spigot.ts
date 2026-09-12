/**
 * `spigot` -- sell files by the byte, or buy them, settled on the kaspa-x402 rail.
 *
 *   spigot serve <dir> [--price N] [--port N] [--babel N]
 *   spigot catalogue <url>
 *   spigot channel open <url> [--escrow KAS]        (buyer: open a channel with a seller)
 *   spigot channels                                 (buyer: list your open channels)
 *   spigot get <url> <path> [--out FILE] [--pay]    (buyer: buy a file; --pay bills the channel)
 *   spigot refund <covenantId>                      (buyer: reclaim a channel after its timeout)
 *   spigot claim <covenantId>                       (seller: claim what a channel voucher covers)
 *   spigot address [--role buyer|seller]
 *
 * The money is a kaspa-x402 escrow channel: the buyer opens one, buys any number of files against
 * it, and refunds the rest. metered decides each bill by two-sided count; their rail pays it.
 */
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { scan, lookup, type Item } from '../src/catalogue.js';
import { serveSpigot, CATALOGUE_PATH } from '../src/seller.js';
import { download, readCatalogue } from '../src/buyer.js';
import { fileTerms, quote, kas, unpayable, payableFrom, DUST_FLOOR_SOMPI } from '../src/terms.js';
import { identity } from '../src/keys.js';
import { fileSessionStore } from 'metered-protocol';
import type { Network } from 'metered-protocol/rail';
import * as chan from '../src/channel.js';

const argv = process.argv.slice(2);
const [command, ...rest] = argv;
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1] ?? fallback;
};
const num = (name: string, fallback: number): number => Number(flag(name, String(fallback)));
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
const NETWORK = flag('network', 'kaspa:testnet-10');
const bare = () => NETWORK.replace(/^kaspa:/, '') as Network;
const network = (cat: { terms: { network: string } }): Network => cat.terms.network.replace(/^kaspa:/, '') as Network;
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function usage(): never {
  console.log([
    '',
    '  spigot -- pay-per-byte file delivery, metered by both sides, settled on kaspa-x402',
    '',
    '    spigot serve <dir> [--price N] [--port N] [--babel N] [--window DAA]',
    '    spigot catalogue <url>',
    '    spigot channel open <url> [--escrow KAS]       buyer: open a channel with a seller',
    '    spigot channels                                buyer: your open channels',
    '    spigot get <url> <path> [--out FILE] [--pay]   buyer: buy a file; --pay bills the channel',
    '    spigot refund <covenantId>                     buyer: reclaim a channel after its timeout',
    '    spigot claim <covenantId>                      seller: claim what a channel voucher covers',
    '    spigot address [--role buyer|seller]',
    '',
  ].join('\n'));
  process.exit(1);
}

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
    network: NETWORK, sompiPerByte: price, babelBytes: num('babel', 64 * 1024),
    largestFileBytes: Math.max(...items.map((i) => i.bytes)), responseWindowDaa: num('window', 600),
  });

  // Verification connects fresh per proposal (see sellerChannels), so serving does not hold a
  // socket open. A one-off probe tells the operator whether a node is reachable at all.
  let channelFor: Parameters<typeof serveSpigot>[0]['channelFor'];
  try {
    const { rpc } = await chan.connect(bare());
    await rpc.disconnect().catch(() => undefined);
    channelFor = chan.sellerChannels(me.publicKeyHex, bare(), Math.max(...items.map((i) => i.bytes)) * price);
    console.log('  channel verification on (a node is reachable)');
  } catch {
    console.log('  channel verification off (no node reachable) -- sessions run unpaid');
  }

  const { server } = serveSpigot({
    root, items, terms, providerSk: me.secretKeyHex, providerPubkey: me.publicKeyHex,
    ...(channelFor ? { channelFor } : {}), sessions: fileSessionStore(`${me.file}.sessions.jsonl`),
  });
  await new Promise<void>((r) => server.listen(num('port', 8402), '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  console.log(`\n  spigot serving ${items.length} file(s) from ${root}`);
  console.log(`  seller ${me.publicKeyHex.slice(0, 16)}...  (${me.file})`);
  console.log(`  ${price} sompi/byte, ${terms.babelUnits} bytes per babel, tolerance ${terms.toleranceAbs}\n`);
  for (const i of items) console.log(`    ${pad(i.path, 40)} ${pad(String(i.bytes), 11)} ${kas(quote(i.bytes, terms))} KAS`);
  const unpaid = unpayable(items, terms);
  if (unpaid.length) {
    console.log(`\n  ${unpaid.length} file(s) earn under the ${DUST_FLOOR_SOMPI} sompi floor and are not worth a claim.`);
    console.log(`  At ${price} sompi/byte a file clears it from ${payableFrom(terms)} bytes.`);
  }
  console.log(`\n  http://127.0.0.1:${port}${CATALOGUE_PATH}\n`);
}

async function catalogue(): Promise<void> {
  const base = positional[0];
  if (!base) usage();
  const cat = await readCatalogue(base);
  console.log(`\n  seller ${cat.sellerPubkey.slice(0, 16)}...  ${cat.items.length} file(s), ${cat.terms.unitPriceSompi} sompi/byte, ${cat.terms.network}\n`);
  for (const i of cat.items) {
    console.log(`    ${pad(i.path, 40)} ${pad(String(i.bytes), 11)} ${kas(i.bytes * cat.terms.unitPriceSompi)} KAS`);
    console.log(`    ${pad('', 40)} ${i.digest}`);
  }
  console.log('');
}

async function channel(): Promise<void> {
  if (positional[0] !== 'open') usage();
  const base = positional[1];
  if (!base) usage();
  const cat = await readCatalogue(base);
  const escrow = BigInt(Math.round(Number(flag('escrow', '1')) * 1e8));
  const me = identity('buyer');

  console.log(`\n  opening a ${kas(Number(escrow))} KAS channel with seller ${cat.sellerPubkey.slice(0, 16)}...`);
  const { channel: c, txid } = await chan.open(me.secretKeyHex, cat.sellerPubkey, network(cat), escrow, BigInt(cat.terms.responseWindowDaa));
  console.log(`  genesis    ${txid}`);
  console.log(`  covenantId ${c.covenantId}`);
  console.log(`  refundable after DAA ${c.timeoutDaa}. Now: spigot get ${base} <file> --pay\n`);
}

async function channels(): Promise<void> {
  const rows = chan.channels();
  if (rows.length === 0) { console.log('\n  no channels. Open one: spigot channel open <url>\n'); return; }
  console.log('');
  for (const r of rows) {
    console.log(`    ${r.channel.covenantId}`);
    console.log(`      seller ${r.sellerPubkey.slice(0, 16)}...  ${kas(Number(r.channel.active.amount))} KAS left  settled ${r.channel.settledTotal}  refund@DAA ${r.channel.timeoutDaa}`);
  }
  console.log('');
}

async function get(): Promise<void> {
  const [base, path] = positional;
  if (!base || !path) usage();
  const cat = await readCatalogue(base);
  const item: Item = lookup(cat.items, path);
  const out = resolve(flag('out', basename(path)));
  const paying = argv.includes('--pay');
  const me = identity('buyer');

  const held = paying ? chan.channelWith(cat.sellerPubkey) : null;
  if (paying && !held) throw new Error(`no open channel with this seller; run: spigot channel open ${base}`);
  const proposal = held ? chan.propose(held) : undefined;

  console.log(`\n  ${item.path}  ${item.bytes} bytes  ->  ${out}`);
  console.log(`  quoted ${kas(item.bytes * cat.terms.unitPriceSompi)} KAS at ${cat.terms.unitPriceSompi} sompi/byte`);
  if (proposal) console.log(`  billed to channel ${proposal.covenantId.slice(0, 16)}...`);

  const { receipt } = await download(base, me.secretKeyHex, item, out, cat.terms.network, undefined, proposal);
  console.log(`\n  ${receipt.babels} babel(s), ${receipt.bytesReceived} bytes received` +
    (receipt.bytesAlreadyHeld ? `, ${receipt.bytesAlreadyHeld} already held` : ''));
  console.log(`  owed ${receipt.sompiSpent} sompi (${kas(receipt.sompiSpent)} KAS)`);
  console.log(`  digest matches the catalogue: ${receipt.digest.slice(0, 24)}...`);
  console.log(proposal
    ? '\n  vouched to the channel with every countersign. The seller claims when it likes.\n'
    : '\n  not billed on chain. The State is signed by both sides; open a channel and use --pay.\n');
}

async function refund(): Promise<void> {
  const covenantId = positional[0];
  if (!covenantId) usage();
  const me = identity('buyer');
  console.log(`\n  refunding channel ${covenantId.slice(0, 16)}... once its timeout passes (this waits)`);
  const out = await chan.refund(me.secretKeyHex, covenantId);
  console.log(`  ${out.txid}\n  ${kas(Number(out.refunded))} KAS back to the buyer\n`);
}

async function claim(): Promise<void> {
  const covenantId = positional[0];
  if (!covenantId) usage();
  const me = identity('seller');
  const voucher = chan.voucherFor(`${me.file}.sessions.jsonl`, covenantId);
  if (!voucher) throw new Error(`no voucher for ${covenantId} in this seller's sessions -- has a buyer paid on it?`);

  const record = chan.recall(covenantId);
  const claimable = BigInt(voucher.amount) - record.channel.settledTotal;
  if (claimable <= 0n) { console.log(`\n  nothing to claim: settled ${record.channel.settledTotal} already covers voucher ${voucher.amount}\n`); return; }

  console.log(`\n  claiming ${kas(Number(claimable))} KAS on channel ${covenantId.slice(0, 16)}... (voucher ceiling ${voucher.amount})`);
  const out = await chan.claim(me.secretKeyHex, covenantId, voucher, claimable);
  console.log(`  ${out.txid}\n  ${kas(Number(out.paid))} KAS to the seller. Escrow continues, settled ${out.channel.settledTotal}.\n`);
}

async function address(): Promise<void> {
  const me = identity(flag('role', 'buyer') === 'seller' ? 'seller' : 'buyer');
  const { sdk, rpc } = await chan.connect(bare());
  const addr = new sdk.PrivateKey(me.secretKeyHex).toKeypair().toAddress(new sdk.NetworkId(bare())).toString();
  const { entries } = await rpc.getUtxosByAddresses([addr]);
  const total = entries.reduce((a: bigint, e: { amount: bigint }) => a + BigInt(e.amount), 0n);
  console.log(`\n  ${addr}\n  ${kas(Number(total))} KAS in ${entries.length} utxo(s)\n  key: ${me.file}\n`);
  await rpc.disconnect().catch(() => undefined);
  process.exit(0);
}

const COMMANDS: Record<string, () => Promise<void>> = { serve, catalogue, channel, channels, get, refund, claim, address };
const run = COMMANDS[command ?? ''];
if (!run) usage();
run().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
