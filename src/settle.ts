/**
 * Putting a finished download on chain.
 *
 * WITHOUT THIS, A DOWNLOAD IS AN AGREEMENT AND NOT A PAYMENT. Every babel is reserved, counted by
 * both sides and doubly signed, which produces a final State that says exactly what is owed -- and
 * a signed number nobody can enforce is a promise. The covenant is what makes it money: consensus
 * holds the funds, pays the seller what the last agreed State says, and returns the rest, whether
 * or not either party is still cooperating.
 *
 * THE ORDER IS FORCED, and not by taste. The covenant's address is derived from the Offer's own
 * parties commitment and session id, so it cannot exist before the session is opened; and the
 * seller should not deliver against funds that are not there. So: open, fund, download, settle,
 * close.
 *
 * None of the chain machinery is reimplemented here. `metered/chain` owns fund, settle and close;
 * this file is the ordering and the money the buyer is willing to put up.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openCovenant, fundCovenant, settleClaim, closeCovenant, loadSdk,
  type Any, type Network,
} from 'metered-protocol/chain';
import { publicKeyHex, signState, requiredFunding, MIN_COVENANT_SOMPI, type Offer, type State } from 'metered-protocol';

export class CannotSettle extends Error {}

/** SPEC.md 7.4b: enough to pay the largest bill this Offer permits, and never below the floor. */
export const fundingFor = (offer: Offer): bigint =>
  BigInt(Math.max(requiredFunding(offer), MIN_COVENANT_SOMPI));

export interface SettlementReceipt {
  covenantAddress: string;
  fundedSompi: bigint;
  settleTxid: string;
  closeTxid: string;
  paidToSeller: number;
  outputs: { address: string; amount: bigint }[];
}

export interface SettleInput {
  offer: Offer;
  /** The final State both sides agreed, and the two signatures over its 72-byte preimage. */
  state: State;
  /**
  * The buyer's session key, which is ALSO the key that funds the covenant and receives the
  * refund. Not a convenience: the covenant requires the refund output to be `P2PK(buyer)` and
  * admits a closing signature only from the buyer's or the seller's session key, so a separate
  * funding wallet would be refused by consensus at close.
  */
  buyerSk: string;
  /** The seller's signature. The buyer signs its own half here; it cannot forge this one. */
  providerSig: string;
  network: Network;
  window: number;
}

/**
 * Fund a covenant for this session and return everything needed to settle against it.
 *
 * Called BEFORE the first babel: a seller has no reason to deliver against an empty covenant, and
 * a buyer has no reason to want it funded any earlier than it must be.
 */
export async function openAndFund(
  offer: Offer, buyerSk: string, network: Network, window: number,
): Promise<{ opened: Any; utxo: Any; sdk: Any; rpc: Any; amount: bigint }> {
  const sdk = await loadSdk();
  const rpc = new sdk.RpcClient({
    resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh,
    networkId: new sdk.NetworkId(network),
  });
  await rpc.connect();

  try {
    const dir = mkdtempSync(join(tmpdir(), 'spigot-covenant-'));
    const opened = await openCovenant(dir, offer, window, network);
    const amount = fundingFor(offer);
    const utxo = await fundCovenant(rpc, sdk, opened, buyerSk, amount, network);
    return { opened, utxo, sdk, rpc, amount };
  } catch (err) {
    await rpc.disconnect().catch(() => undefined);
    throw err;
  }
}

/**
 * Post the agreed State and pay everyone out.
 *
 * The buyer signs its own half of the claim here rather than being handed a complete one: a State
 * it has not signed is a State it has not agreed to, and settling against one would give away the
 * only thing its signature is for.
 */
export async function settleAndClose(
  chain: { opened: Any; utxo: Any; sdk: Any; rpc: Any; amount: bigint },
  input: SettleInput,
): Promise<SettlementReceipt> {
  const { sdk, rpc, opened, utxo } = chain;
  const buyerPubkey = publicKeyHex(input.buyerSk);
  const networkId = new sdk.NetworkId(input.network);
  const buyerAddress = new sdk.PrivateKey(input.buyerSk).toKeypair().toAddress(networkId).toString();
  // DERIVED, NOT ADVERTISED. The covenant pays to P2PK of the key in the Offer, so computing the
  // address from that key is the only version the buyer can be sure consensus will accept -- and
  // it removes any chance of paying an address a seller merely claimed was its own.
  const sellerAddress = new sdk.PublicKey(input.offer.providerPubkey).toAddress(networkId).toString();

  try {
    const claim = await settleClaim(rpc, sdk, opened, utxo, input.state, {
      buyerPubkey,
      providerPubkey: input.offer.providerPubkey,
      buyerSig: signState(input.state, input.buyerSk),
      providerSig: input.providerSig,
    }, input.network);

    const closed = await closeCovenant(rpc, sdk, opened, claim, {
      buyerPubkey,
      providerPubkey: input.offer.providerPubkey,
      // The BUYER closes here, which it may: `expire` admits `checkSig(buyer) || checkSig(provider)`
      // once the window has passed. It must sign with its SESSION key -- no other key satisfies
      // that check, however much of the money it put up.
      signerSk: input.buyerSk,
      buyerAddress,
      providerAddress: sellerAddress,
    }, input.state.cumulativeSompi);

    return {
      covenantAddress: opened.address,
      fundedSompi: chain.amount,
      settleTxid: claim.txid,
      closeTxid: closed.txid,
      paidToSeller: input.state.cumulativeSompi,
      outputs: closed.outputs,
    };
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}
