/**
 * Where a seller's and a buyer's identities live.
 *
 * A metered session is between two public keys, so both sides need a stable one: a seller that
 * generated a fresh key on every start would be a different seller to every buyer, and a buyer
 * that did the same could never be recognised across sessions.
 *
 * These are ordinary secp256k1 secrets held in plain files, mode 0600, outside any repository --
 * the same shape as an SSH key and with the same warning attached. They are NOT a wallet: no
 * settlement key is stored here, because losing this file should cost an identity and never
 * coins.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { publicKeyHex } from 'metered';

const HOME = join(homedir(), '.spigot');

export type Role = 'seller' | 'buyer';

export interface Identity {
  secretKeyHex: string;
  publicKeyHex: string;
  file: string;
}

/**
 * Load this role's key, creating one the first time.
 *
 * Created rather than demanded because a first run that fails with "no key" teaches nothing: the
 * key has no meaning until a session uses it, and there is nothing for a person to choose.
 */
export function identity(role: Role): Identity {
  mkdirSync(HOME, { recursive: true });
  const file = join(HOME, `${role}.key`);

  if (!existsSync(file)) {
    writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  }
  // Set on every load, not only on creation: a key restored from a backup or copied between
  // machines commonly arrives world-readable, and the moment it is read is the moment to fix it.
  chmodSync(file, 0o600);

  const secretKeyHex = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) {
    throw new Error(`${file} does not contain a 32-byte hex secret key`);
  }
  return { secretKeyHex, publicKeyHex: publicKeyHex(secretKeyHex), file };
}
