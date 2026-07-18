import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

type SuiNetwork = 'testnet' | 'mainnet';

/** `.rill/keys/agent-<network>.key` under the config dir (RILL_CONFIG_DIR or cwd). */
export function keystoreDir(baseDir = process.env.RILL_CONFIG_DIR ?? process.cwd()): string {
  return join(baseDir, '.rill', 'keys');
}
export function keystorePath(network: SuiNetwork, baseDir?: string): string {
  return join(keystoreDir(baseDir), `agent-${network}.key`);
}

/**
 * Loads the agent's local keypair for `network`, generating and persisting one on first use.
 * The persisted file is the `suiprivkey1…` bech32 string, written 0600. Separate file per network so
 * a testnet key can never be reused on mainnet by accident.
 */
export function loadOrCreateKeypair(
  network: SuiNetwork,
  baseDir?: string,
): { keypair: Ed25519Keypair; created: boolean } {
  const path = keystorePath(network, baseDir);
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf8').trim();
    return { keypair: Ed25519Keypair.fromSecretKey(secret), created: false };
  }
  mkdirSync(keystoreDir(baseDir), { recursive: true });
  const keypair = Ed25519Keypair.generate();
  writeFileSync(path, keypair.getSecretKey(), { mode: 0o600 });
  return { keypair, created: true };
}
