import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * @rill/signer core — the agent's "hand + signature".
 *
 * Rill's hosted MCP/REST builds an UNSIGNED PTB (it never holds a key). This signs it locally:
 * decode → re-simulate (drift check) → soft gas cap → sign + submit. Protocol-agnostic — it signs
 * whatever bytes it's given. The HARD budget/expiry/revoke caps live on-chain in `agent_wallet`,
 * baked into the PTB; this is the local signing mechanism + a soft UX gate, not the money-safety source.
 */

export type SuiNetwork = 'mainnet' | 'testnet';

export interface SignerConfig {
  network: SuiNetwork;
  rpcUrl?: string;
  /** Sui private key (`suiprivkey1…` from `sui keytool export`). Required to sign. */
  secretKey?: string;
  /** MAINNET GUARD: must be true to sign on mainnet. Default false. */
  allowMainnet: boolean;
  /** Reject if the re-simulation does not predict success. Default true. */
  requireSimSuccess: boolean;
  /** Reject if estimated gas (computation + storage, MIST) exceeds this. */
  maxGasBudgetMist?: bigint;
}

export interface Signer {
  readonly address: string | undefined;
  readonly network: SuiNetwork;
  readonly client: SuiJsonRpcClient;
  hasKey(): boolean;
}

/** Reads config from env: RILL_SUI_PRIVATE_KEY (or SUI_PRIVATE_KEY), SUI_NETWORK, SUI_RPC_URL, RILL_ALLOW_MAINNET, RILL_MAX_GAS_MIST. */
export function loadConfigFromEnv(env: Record<string, string | undefined> = process.env): SignerConfig {
  const network = (env.SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as SuiNetwork;
  return {
    network,
    rpcUrl: env.SUI_RPC_URL,
    secretKey: env.RILL_SUI_PRIVATE_KEY ?? env.SUI_PRIVATE_KEY,
    allowMainnet: (env.RILL_ALLOW_MAINNET ?? 'false').toLowerCase() === 'true',
    requireSimSuccess: (env.RILL_REQUIRE_SIM_SUCCESS ?? 'true').toLowerCase() !== 'false',
    maxGasBudgetMist: env.RILL_MAX_GAS_MIST ? BigInt(env.RILL_MAX_GAS_MIST) : undefined,
  };
}

export function createSigner(cfg: SignerConfig): Signer {
  const client = new SuiJsonRpcClient({
    url: cfg.rpcUrl ?? getJsonRpcFullnodeUrl(cfg.network),
    network: cfg.network,
  });
  const keypair = cfg.secretKey ? Ed25519Keypair.fromSecretKey(cfg.secretKey) : undefined;
  const address = keypair?.getPublicKey().toSuiAddress();
  // Stash for executePtb without re-deriving.
  signerKeys.set(client, keypair);
  return { address, network: cfg.network, client, hasKey: () => keypair !== undefined };
}

const signerKeys = new WeakMap<SuiJsonRpcClient, Ed25519Keypair | undefined>();

export interface ExecuteResult {
  digest: string;
  status: string;
  gasUsedMist: string;
  explorerUrl: string;
  effects: unknown;
}

interface GasUsed {
  computationCost: string;
  storageCost: string;
}

/** Decode the builder's base64 unsignedPtb → re-simulate → soft policy → sign + submit. */
export async function executePtb(
  unsignedPtb: string,
  signer: Signer,
  cfg: SignerConfig,
): Promise<ExecuteResult> {
  const keypair = signerKeys.get(signer.client);
  if (!keypair) {
    throw new Error('No key configured. Set RILL_SUI_PRIVATE_KEY (suiprivkey1…) before signing.');
  }
  if (signer.network === 'mainnet' && !cfg.allowMainnet) {
    throw new Error('Refusing to sign on mainnet. Set RILL_ALLOW_MAINNET=true to opt in.');
  }

  // Rill sends base64 of the serialized tx (`Buffer.from(tx.serialize()).toString('base64')`).
  const tx = Transaction.from(Buffer.from(unsignedPtb, 'base64').toString('utf8'));

  // Re-simulate (catch drift since the builder's sim; no gas, no signature).
  const sim = await signer.client.devInspectTransactionBlock({
    sender: signer.address!,
    transactionBlock: tx,
  });
  const status = sim.effects.status.status;
  if (cfg.requireSimSuccess && status !== 'success') {
    throw new Error(`Simulation failed (${sim.effects.status.error ?? status}). Aborting before signing.`);
  }

  if (cfg.maxGasBudgetMist !== undefined) {
    const gas = sim.effects.gasUsed as GasUsed;
    const estGas = BigInt(gas.computationCost) + BigInt(gas.storageCost);
    if (estGas > cfg.maxGasBudgetMist) {
      throw new Error(`Estimated gas ${estGas} MIST exceeds RILL_MAX_GAS_MIST ${cfg.maxGasBudgetMist}.`);
    }
  }

  const res = await signer.client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  await signer.client.waitForTransaction({ digest: res.digest });

  const execStatus = res.effects?.status.status ?? 'unknown';
  if (execStatus !== 'success') {
    throw new Error(`Execution failed: ${res.effects?.status.error ?? execStatus} (digest ${res.digest})`);
  }
  const gas = (res.effects?.gasUsed as GasUsed | undefined) ?? { computationCost: '0', storageCost: '0' };
  return {
    digest: res.digest,
    status: execStatus,
    gasUsedMist: (BigInt(gas.computationCost) + BigInt(gas.storageCost)).toString(),
    explorerUrl: `https://suiscan.xyz/${signer.network}/tx/${res.digest}`,
    effects: res.effects ?? null,
  };
}
