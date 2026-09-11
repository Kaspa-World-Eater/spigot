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
import { fileTerms, quote, kas } from '../src/terms.js';
import { identity } from '../src/keys.js';

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

    spigot get <url> <path> [--out FILE] [--network ID]
        Buy one file, one babel at a time, counting every byte.
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

  console.log(`\n  ${item.path}  ${item.bytes} bytes  ->  ${out}`);
  console.log(`  quoted ${kas(item.bytes * cat.terms.unitPriceSompi)} KAS at ${cat.terms.unitPriceSompi} sompi/byte\n`);

  const me = identity('buyer');
  const { receipt } = await download(base, me.secretKeyHex, item, out, cat.terms.network);

  console.log(`  ${receipt.babels} babel(s), ${receipt.bytesReceived} bytes received` +
    (receipt.bytesAlreadyHeld ? `, ${receipt.bytesAlreadyHeld} already held` : ''));
  console.log(`  paid ${receipt.sompiSpent} sompi (${kas(receipt.sompiSpent)} KAS)`);
  console.log(`  digest matches the catalogue: ${receipt.digest.slice(0, 24)}...\n`);
}

const COMMANDS: Record<string, () => Promise<void>> = { serve, catalogue, get };

const run = COMMANDS[command ?? ''];
if (!run) usage();
run().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
