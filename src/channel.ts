/**
 * spigot's money, on the kaspa-x402 rail.
 *
 * A BUYER opens a channel with a seller once, buys any number of files against it, and takes the
 * remainder back after the timeout. A SELLER verifies a proposed channel before billing against it
 * and claims what its vouchers cover whenever it likes. Every one of those is metered-protocol's
 * rail doing the chain work over kaspa-x402.org's escrow; this file decides WHICH channel, keeps
 * the records, and nothing else.
 *
 * RECORDS ARE THE WHOLE JOB. An escrow script embeds both parties' keys and cannot be spent
 * without reproducing it, so a channel whose record is lost is a channel whose money is lost.
 * metered's own tooling learnt that by stranding three. Here a channel is written to disk the
 * moment it exists, before anything else is allowed to happen to it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChannelProposal } from 'metered-protocol';
import {
  openChannel, claimChannel, refundChannel, channelVerifier, proposalFor, redeemScriptFor, loadSdk, awaitUtxo, spendWallet,
  type Channel, type Network, type Any,
} from 'metered-protocol/rail';
import type { Voucher } from 'metered-protocol';

const HOME = join(homedir(), '.spigot', 'channels');
export const GENESIS_FEE = 500_000n;
export const CLAIM_FEE = 500_000n;
export const REFUND_FEE = 500_000n;

export class NoChannel extends Error {}

/** One record per channel, by covenant id. Amounts are strings on disk because they are bigints. */
interface Record { channel: Channel; sellerPubkey: string; openedAt: string }

const file = (covenantId: string) => join(HOME, `${covenantId}.json`);
const dehydrate = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
const hydrate = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export function remember(channel: Channel, sellerPubkey: string): void {
  mkdirSync(HOME, { recursive: true });
  const record: Record = { channel, sellerPubkey, openedAt: new Date().toISOString() };
  writeFileSync(file(channel.covenantId), JSON.stringify(record, dehydrate, 2), { mode: 0o600 });
}

export function recall(covenantId: string): Record {
  if (!existsSync(file(covenantId))) throw new NoChannel(`no record of channel ${covenantId}`);
  return JSON.parse(readFileSync(file(covenantId), 'utf8'), hydrate) as Record;
}

export function channels(): Record[] {
  if (!existsSync(HOME)) return [];
  return readdirSync(HOME).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(HOME, f), 'utf8'), hydrate) as Record);
}

/** The buyer's open channel with this seller, if it has one with anything left in it. */
export function channelWith(sellerPubkey: string): Record | null {
  return channels().find((r) => r.sellerPubkey === sellerPubkey && r.channel.active.amount > 0n) ?? null;
}

export async function connect(network: Network): Promise<{ sdk: Any; rpc: Any; networkId: Any }> {
  const sdk = await loadSdk();
  const networkId = new sdk.NetworkId(network);
  const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
  await rpc.connect();
  return { sdk, rpc, networkId };
}

/** Their genesis wants one input of exactly escrow + fee. Ordinary wallets do not hold that, so make it. */
async function carve(rpc: Any, sdk: Any, sk: string, network: Network, amount: bigint) {
  const from = new sdk.PrivateKey(sk).toKeypair().toAddress(new sdk.NetworkId(network)).toString();
  const { txid } = await spendWallet(rpc, sdk, sk, network, [{ address: from, amount }]);
  const landed = await awaitUtxo(rpc, from, amount);
  if (!landed) throw new Error('the carved UTXO never appeared');
  return { txid, index: Number(landed.outpoint.index), amount };
}

/** BUYER: open a channel with a seller. Written to disk before this returns. */
export async function open(
  buyerSk: string, sellerPubkey: string, network: Network, escrowSompi: bigint, windowDaa: bigint,
): Promise<{ channel: Channel; txid: string }> {
  const { sdk, rpc } = await connect(network);
  try {
    const funding = await carve(rpc, sdk, buyerSk, network, escrowSompi + GENESIS_FEE);
    const opened = await openChannel(rpc, sdk, {
      buyerSk, providerPubkey: sellerPubkey, network, windowDaa, escrowSompi, feeSompi: GENESIS_FEE, funding,
    });
    remember(opened.channel, sellerPubkey);
    return opened;
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

/** BUYER: what to tell the seller when opening a session against a channel. */
export const propose = (record: Record): ChannelProposal => proposalFor(record.channel);

/** BUYER: take back what the seller never claimed, once the timeout has passed. */
export async function refund(buyerSk: string, covenantId: string): Promise<{ txid: string; refunded: bigint }> {
  const record = recall(covenantId);
  const { sdk, rpc } = await connect(record.channel.network);
  try {
    const out = await refundChannel(rpc, sdk, record.channel, buyerSk, REFUND_FEE);
    remember({ ...record.channel, active: { ...record.channel.active, amount: 0n } }, record.sellerPubkey);
    return out;
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

/**
 * SELLER: the check a proposed channel must pass, and a memory of the ones that did.
 *
 * The verifier is metered's; what spigot adds is keeping the proposal it accepted, because a
 * claim later needs the channel's terms and the proposal is where the seller learnt them.
 */
export function sellerChannels(sellerPubkey: string, network: Network, requiredSompi: number) {
  return async (buyerPubkey: string, proposal: ChannelProposal) => {
    // A FRESH CONNECTION PER CHECK. A channel is proposed minutes or hours after the server
    // started, and a public testnet node drops an idle socket long before then -- a verifier
    // holding the startup connection races a dead handle and takes the whole process down with
    // it (a libuv assertion, seen once). Opening and closing here costs a round trip and owes
    // nothing to how long the server has been up.
    const { sdk, rpc } = await connect(network);
    let ok: { covenantId: string; vouchedSompi: number } | null;
    try {
      ok = await channelVerifier(rpc, sdk, sellerPubkey, network, requiredSompi)(buyerPubkey, proposal);
    } finally {
      await rpc.disconnect().catch(() => undefined);
    }
    if (!ok) return null;
    const channel: Channel = {
      network, theirNetwork: `kaspa:${network}` as Channel['theirNetwork'], covenantId: proposal.covenantId,
      buyerPubkey, providerPubkey: sellerPubkey,
      timeoutDaa: BigInt(proposal.timeoutDaa), settledTotal: BigInt(proposal.settledTotal),
      active: { ...proposal.active, amount: BigInt(proposal.active.amount), redeemScript: '' },
    };
    // The proposal carries no script; the terms determine it, and the verifier has already
    // refused any proposal whose script public key disagrees with this rebuild.
    channel.active.redeemScript = redeemScriptFor(channel);
    remember(channel, sellerPubkey);
    return ok;
  };
}

/**
 * SELLER: find the latest voucher for a channel in a persisted session store.
 *
 * The seller's sessions are written to JSONL by metered's `fileSessionStore`; each snapshot for a
 * session on this channel carries the voucher it last held. The highest-ceiling one is what to
 * claim -- it authorises everything the earlier ones did.
 */
export function voucherFor(sessionStorePath: string, covenantId: string): Voucher | null {
  if (!existsSync(sessionStorePath)) return null;
  let best: Voucher | null = null;
  for (const line of readFileSync(sessionStorePath, 'utf8').split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    const snap = (JSON.parse(line) as { snapshot?: { offer?: { channel?: { covenantId: string } }; lastVoucher?: Voucher | null } }).snapshot;
    const v = snap?.lastVoucher;
    if (snap?.offer?.channel?.covenantId === covenantId && v && (!best || BigInt(v.amount) > BigInt(best.amount))) best = v;
  }
  return best;
}

/** SELLER: claim what a voucher covers on a channel it accepted. */
export async function claim(sellerSk: string, covenantId: string, voucher: Voucher, claimSompi: bigint): Promise<{ txid: string; paid: bigint; channel: Channel }> {
  const record = recall(covenantId);
  const { sdk, rpc } = await connect(record.channel.network);
  try {
    const out = await claimChannel(rpc, sdk, record.channel, voucher, sellerSk, claimSompi, CLAIM_FEE);
    remember(out.channel, record.sellerPubkey);
    return { txid: out.txid, paid: out.paidToSeller, channel: out.channel };
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}
