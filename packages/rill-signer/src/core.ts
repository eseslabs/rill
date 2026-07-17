import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { ExecutionEnvelope } from '../../rill-sdk/src/types';
import {
  assertCapabilitiesActive,
  validateExecutionEnvelope,
  type LocalSignerPolicy,
} from './policy';

/**
 * @rill/signer core — the agent's "hand + signature".
 *
 * Rill's hosted MCP/REST builds an UNSIGNED PTB (it never holds a key). This signs it locally:
 * validate envelope + exact PTB → check live capabilities → re-simulate → sign + submit.
 * Raw PTB signing remains available only through the explicitly unsafe development API.
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
  readonly client: SuiGrpcClient;
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
  const client = new SuiGrpcClient({
    baseUrl: cfg.rpcUrl ?? 'https://fullnode.testnet.sui.io:443',
    network: cfg.network,
  });
  const keypair = cfg.secretKey ? Ed25519Keypair.fromSecretKey(cfg.secretKey) : undefined;
  const address = keypair?.getPublicKey().toSuiAddress();
  // Stash for execution without re-deriving.
  signerKeys.set(client, keypair);
  return { address, network: cfg.network, client, hasKey: () => keypair !== undefined };
}

const signerKeys = new WeakMap<SuiGrpcClient, Ed25519Keypair | undefined>();

export interface ExecuteResult {
  digest: string;
  status: string;
  gasUsedMist: string;
  explorerUrl: string;
  effects: unknown;
}

export interface TransactionEffects {
  changedObjects?: readonly { objectId: string; idOperation: string }[];
  gasUsed?: GasUsed;
  status?: { success: boolean; error?: { message?: string } };
}

interface GasUsed {
  computationCost: string;
  storageCost: string;
}

const ZERO_GAS_USED: GasUsed = {
  computationCost: '0',
  storageCost: '0',
};

function sumGasUsedMist(gasUsed: GasUsed | undefined): bigint {
  const gas = gasUsed ?? ZERO_GAS_USED;
  return BigInt(gas.computationCost) + BigInt(gas.storageCost);
}

export function extractCreatedObjectId(
  result: { effects?: { changedObjects?: readonly { objectId: string; idOperation: string }[] }; objectTypes?: Record<string, string> },
  suffix: string,
): string {
  const objectId = (result.effects?.changedObjects ?? [])
    .filter((item) => item.idOperation === 'Created')
    .find((item) => result.objectTypes?.[item.objectId]?.includes(suffix))?.objectId;
  if (!objectId) throw new Error(`Created ${suffix} object not found.`);
  return objectId;
}

export async function signAndExecutePtb(
  unsignedPtbBase64: string,
  signer: Signer,
  cfg: SignerConfig,
): Promise<ExecuteResult> {
  const keypair = signerKeys.get(signer.client);
  if (!keypair || !signer.address) throw new Error('No local signer key configured.');
  if (signer.network === 'mainnet' && !cfg.allowMainnet) {
    throw new Error('Refusing to sign on mainnet. Set RILL_ALLOW_MAINNET=true to opt in.');
  }

  const tx = Transaction.from(Buffer.from(unsignedPtbBase64, 'base64').toString('utf8'));
  const sim = await signer.client.simulateTransaction({ transaction: tx, include: { effects: true } });
  if (sim.$kind === 'FailedTransaction' && cfg.requireSimSuccess) {
    throw new Error(`Simulation failed (${sim.FailedTransaction.effects?.status.error?.message ?? 'unknown'}). Aborting before signing.`);
  }

  if (cfg.maxGasBudgetMist !== undefined && sim.$kind === 'Transaction') {
    const estGas = sumGasUsedMist(sim.Transaction.effects?.gasUsed as GasUsed | undefined);
    if (estGas > cfg.maxGasBudgetMist) {
      throw new Error(`Estimated gas ${estGas} MIST exceeds RILL_MAX_GAS_MIST ${cfg.maxGasBudgetMist}.`);
    }
  }

  const res = await signer.client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    include: { effects: true, objectTypes: true },
  });
  if (res.$kind === 'FailedTransaction') {
    throw new Error(`Execution failed: ${res.FailedTransaction.effects?.status.error?.message ?? 'unknown'}.`);
  }
  await signer.client.waitForTransaction({ digest: res.Transaction.digest, include: { effects: true } });

  const effects = res.Transaction.effects;
  const execStatus = effects?.status.success ? 'success' : 'failure';
  if (cfg.requireSimSuccess && execStatus !== 'success') {
    throw new Error(`Execution failed: ${effects?.status.error?.message ?? execStatus} (digest ${res.Transaction.digest})`);
  }
  return {
    digest: res.Transaction.digest,
    status: execStatus,
    gasUsedMist: sumGasUsedMist(effects?.gasUsed as GasUsed | undefined).toString(),
    explorerUrl: `https://suiscan.xyz/${signer.network}/tx/${res.Transaction.digest}`,
    effects: res.Transaction as unknown,
  };
}

export async function executeEnvelope(
  envelope: ExecutionEnvelope,
  signer: Signer,
  cfg: SignerConfig,
  policy: LocalSignerPolicy,
): Promise<ExecuteResult> {
  const keypair = signerKeys.get(signer.client);
  if (!keypair || !signer.address) throw new Error('No local signer key configured.');
  if (signer.network === 'mainnet' && !cfg.allowMainnet) {
    throw new Error('Refusing to sign on mainnet.');
  }

  const validated = await validateExecutionEnvelope(envelope, signer.address, signer.network, policy);
  await assertCapabilitiesActive(signer.client, policy, validated.spendAmountMist);
  const sim = await signer.client.simulateTransaction({
    transaction: validated.transaction,
    include: { effects: true },
  });
  if (sim.$kind === 'FailedTransaction') {
    throw new Error(`Exact PTB re-simulation failed (${sim.FailedTransaction.effects?.status.error?.message ?? 'unknown'}).`);
  }

  if (cfg.maxGasBudgetMist !== undefined) {
    const estimate = sumGasUsedMist(sim.Transaction.effects?.gasUsed as GasUsed | undefined);
    if (estimate > cfg.maxGasBudgetMist) {
      throw new Error(`Estimated gas ${estimate} MIST exceeds local policy.`);
    }
  }

  const result = await signer.client.signAndExecuteTransaction({
    signer: keypair,
    transaction: validated.transaction,
    include: { effects: true, events: true, objectTypes: true },
  });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`Execution failed: ${result.FailedTransaction.effects?.status.error?.message ?? 'unknown'}.`);
  }
  await signer.client.waitForTransaction({ digest: result.Transaction.digest, include: { effects: true } });
  if (result.Transaction.effects?.status.success !== true) {
    throw new Error(`Execution failed: ${result.Transaction.effects?.status.error?.message ?? 'unknown'}.`);
  }
  return {
    digest: result.Transaction.digest,
    status: 'success',
    gasUsedMist: sumGasUsedMist(result.Transaction.effects?.gasUsed as GasUsed | undefined).toString(),
    explorerUrl: `https://suiscan.xyz/${signer.network}/tx/${result.Transaction.digest}`,
    effects: result.Transaction as unknown,
  };
}

/** Development-only raw PTB path. Demo Day execution must use executeEnvelope. */
export async function executeUnsafePtb(
  unsignedPtb: string,
  signer: Signer,
  cfg: SignerConfig,
): Promise<ExecuteResult> {
  const keypair = signerKeys.get(signer.client);
  if (!keypair) {
    throw new Error('No key configured. Set RILL_SUI_PRIVATE_KEY (suiprivkey1…) before signing.');
  }
  return signAndExecutePtb(unsignedPtb, signer, cfg);
}

/** Disabled until Task 9 replaces the legacy raw MCP tool with bounded envelope tools. */
export async function executePtb(
  _unsignedPtb: string,
  _signer: Signer,
  _cfg: SignerConfig,
): Promise<ExecuteResult> {
  throw new Error('Raw PTB execution is disabled. Use executeEnvelope or explicit --unsafe-ptb development mode.');
}
