import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { parseU64String } from '../../rill-sdk/src/amounts';
import { digestUnsignedPtb } from '../../rill-sdk/src/execution-envelope';
import type { ExecutionEnvelope } from '../../rill-sdk/src/types';
import {
  assertCapabilitiesActive,
  validateExecutionEnvelope,
  type LocalSignerPolicy,
} from './policy';
import { loadOrCreateKeypair, keystorePath } from './keystore';

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
  /**
   * R10 mandatory gas ceiling: reject if estimated gas (computation + storage, MIST) exceeds this.
   * Always resolved by loadConfigFromEnv (from RILL_MAX_GAS_MIST when set, else a generous default) —
   * never undefined — so the ceiling is always enforced, and the same value backs both the gas-budget
   * check and executeEnvelope's spend+gas outflow bound (R9).
   */
  maxGasBudgetMist: bigint;
  /**
   * Base dir for the local keystore fallback used when `secretKey` is absent (see createSigner).
   * Passed straight through to keystore.ts's `loadOrCreateKeypair`/`keystorePath`, which default it to
   * `RILL_CONFIG_DIR ?? process.cwd()` when this is left unset. Not populated by loadConfigFromEnv —
   * mainly here so callers (and tests) can point the keystore at an isolated directory.
   */
  keystoreBaseDir?: string;
}

export interface Signer {
  readonly address: string | undefined;
  readonly network: SuiNetwork;
  readonly client: SuiGrpcClient;
  hasKey(): boolean;
}

/**
 * R10 mandatory gas ceiling default: 0.1 SUI. Generous enough to comfortably exceed observed
 * DeepBook hero-flow gas usage (a handful of MoveCalls plus one split/merge, typically well under
 * 0.01 SUI) so this hardening cannot brick the one proven live path, while still bounding every
 * envelope's signer-visible gas exposure by default when RILL_MAX_GAS_MIST is not set.
 */
const DEFAULT_MAX_GAS_BUDGET_MIST = 100_000_000n;

/** Reads config from env: RILL_SUI_PRIVATE_KEY (or SUI_PRIVATE_KEY), SUI_NETWORK, SUI_RPC_URL, RILL_ALLOW_MAINNET, RILL_MAX_GAS_MIST. */
export function loadConfigFromEnv(env: Record<string, string | undefined> = process.env): SignerConfig {
  const network = (env.SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as SuiNetwork;
  return {
    network,
    rpcUrl: env.SUI_RPC_URL,
    secretKey: env.RILL_SUI_PRIVATE_KEY ?? env.SUI_PRIVATE_KEY,
    allowMainnet: (env.RILL_ALLOW_MAINNET ?? 'false').toLowerCase() === 'true',
    requireSimSuccess: (env.RILL_REQUIRE_SIM_SUCCESS ?? 'true').toLowerCase() !== 'false',
    maxGasBudgetMist: env.RILL_MAX_GAS_MIST
      ? parseU64String(env.RILL_MAX_GAS_MIST, 'RILL_MAX_GAS_MIST')
      : DEFAULT_MAX_GAS_BUDGET_MIST,
  };
}

type SignerKeypair = Ed25519Keypair | Secp256k1Keypair | Secp256r1Keypair;

/**
 * R10 key scheme detection: `suiprivkey1…` bech32-encodes a one-byte signature-scheme flag ahead of
 * the raw 32-byte secret, so a single private-key string can hold an Ed25519, Secp256k1, or
 * Secp256r1 key. Unconditionally constructing an Ed25519Keypair (the old behavior) throws for the
 * other two schemes; decode the flag first via the SDK's own decodeSuiPrivateKey helper and build the
 * matching class so a Secp256k1/Secp256r1 operator key works too.
 */
function keypairFromSuiPrivateKey(secretKey: string): SignerKeypair {
  const decoded = decodeSuiPrivateKey(secretKey);
  switch (decoded.scheme) {
    case 'ED25519':
      return Ed25519Keypair.fromSecretKey(decoded.secretKey);
    case 'Secp256k1':
      return Secp256k1Keypair.fromSecretKey(decoded.secretKey);
    case 'Secp256r1':
      return Secp256r1Keypair.fromSecretKey(decoded.secretKey);
    default:
      throw new Error(
        `Unsupported signer key scheme "${decoded.scheme}". Only ED25519, Secp256k1, and Secp256r1 keys are supported.`,
      );
  }
}

/**
 * Resolves the signing keypair for `createSigner`: an explicit `cfg.secretKey` (operator-pinned env
 * key) always wins; otherwise falls back to the local keystore (`.rill/keys/agent-<network>.key`),
 * which generates a keypair on first use and reuses it thereafter — this is how the agent "creates a
 * wallet locally if it doesn't have one." When a new key is generated, a one-line notice is logged to
 * stderr (never stdout, never the secret) so the operator knows to fund the address.
 */
function resolveSignerKeypair(cfg: SignerConfig): SignerKeypair {
  if (cfg.secretKey) return keypairFromSuiPrivateKey(cfg.secretKey);
  const { keypair, created } = loadOrCreateKeypair(cfg.network, cfg.keystoreBaseDir);
  if (created) {
    const address = keypair.getPublicKey().toSuiAddress();
    const path = keystorePath(cfg.network, cfg.keystoreBaseDir);
    console.error(
      `rill-signer: no signer key configured — generated a new local ${cfg.network} keypair at ${path}. `
        + `Fund ${address} before signing anything.`,
    );
  }
  return keypair;
}

export function createSigner(cfg: SignerConfig): Signer {
  const client = new SuiGrpcClient({
    baseUrl: cfg.rpcUrl ?? 'https://fullnode.testnet.sui.io:443',
    network: cfg.network,
  });
  const keypair = resolveSignerKeypair(cfg);
  const address = keypair.getPublicKey().toSuiAddress();
  // Stash for execution without re-deriving. Only the derived keypair is retained: the raw
  // suiprivkey1… string is cleared from the config object below so nothing downstream (logging, an
  // error dump, a future code path reading `cfg`) can read it back out (R10).
  signerKeys.set(client, keypair);
  delete cfg.secretKey;
  return { address, network: cfg.network, client, hasKey: () => keypair !== undefined };
}

const signerKeys = new WeakMap<SuiGrpcClient, SignerKeypair | undefined>();

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

const SUI_COIN_TYPE = '0x2::sui::SUI';

interface SimulatedBalanceChange {
  coinType: string;
  address: string;
  amount: string;
}

/**
 * R9 effects check: sums the sender's own SUI balance changes from a dry run into a single net
 * outflow (MIST). Sui balance-change amounts are signed decimal integer strings (negative = outflow,
 * positive = inflow) — everything here stays in bigint, parsed with a plain sign-tolerant regex
 * rather than the SDK's parseU64String, which is u64/non-negative only and so cannot itself parse a
 * signed delta. A net inflow (or exactly zero) is not an "outflow" the spend+gas bound needs to
 * cover, so it is reported as 0 rather than a negative number.
 */
function sumSenderSuiOutflowMist(balanceChanges: readonly SimulatedBalanceChange[], senderAddress: string): bigint {
  const sender = normalizeSuiAddress(senderAddress);
  let netMist = 0n;
  for (const change of balanceChanges) {
    if (change.coinType !== SUI_COIN_TYPE) continue;
    if (normalizeSuiAddress(change.address) !== sender) continue;
    if (!/^-?\d+$/.test(change.amount)) {
      throw new Error(`Simulated balance change amount "${change.amount}" is not a signed integer.`);
    }
    netMist += BigInt(change.amount);
  }
  return netMist < 0n ? -netMist : 0n;
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

  if (sim.$kind === 'Transaction') {
    const estGas = sumGasUsedMist(sim.Transaction.effects?.gasUsed as GasUsed | undefined);
    if (estGas > cfg.maxGasBudgetMist) {
      throw new Error(`Estimated gas ${estGas} MIST exceeds the gas ceiling ${cfg.maxGasBudgetMist} MIST.`);
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

  const validated = await validateExecutionEnvelope(
    envelope,
    signer.address,
    signer.network,
    policy,
    undefined,
    cfg.maxGasBudgetMist,
  );

  // TOCTOU byte pinning (R11): re-derive the unsignedPtb text exactly as validateExecutionEnvelope's
  // Transaction.from(...) parsed it and re-confirm its digest against the envelope's actionDigest,
  // using the identical recipe digestUnsignedPtb uses. Synchronous and network-free, so it runs
  // before anything else touches `validated.transaction` (in particular before simulateTransaction,
  // whose own serialization step sorts commands/inputs in place) — it catches a parse/serialize
  // round-trip inconsistency in the underlying SDK, or any future code change that mutates the
  // transaction before it is used, rather than silently simulating or signing bytes that no longer
  // match what policy inspected.
  const pinnedPtb = Buffer.from(validated.transaction.serialize()).toString('base64');
  if (await digestUnsignedPtb(pinnedPtb) !== envelope.actionDigest) {
    throw new Error('Transaction no longer matches the envelope actionDigest; refusing to sign.');
  }

  await assertCapabilitiesActive(signer.client, policy, validated.spendAmountMist);
  const sim = await signer.client.simulateTransaction({
    transaction: validated.transaction,
    include: { effects: true, balanceChanges: true },
  });
  if (sim.$kind === 'FailedTransaction') {
    throw new Error(`Exact PTB re-simulation failed (${sim.FailedTransaction.effects?.status.error?.message ?? 'unknown'}).`);
  }

  const estimatedGasMist = sumGasUsedMist(sim.Transaction.effects?.gasUsed as GasUsed | undefined);
  if (estimatedGasMist > cfg.maxGasBudgetMist) {
    throw new Error(`Estimated gas ${estimatedGasMist} MIST exceeds the gas ceiling ${cfg.maxGasBudgetMist} MIST.`);
  }

  // R9: after re-simulation succeeds, check effects — total sender SUI outflow (spend plus gas plus
  // anything else) must not exceed the declared spend plus the gas ceiling. Computed from the dry
  // run's own balanceChanges rather than trusted a priori, so a PTB that is structurally within
  // policy but drains more than expected at execution time is still caught before anything is signed.
  const senderOutflowMist = sumSenderSuiOutflowMist(sim.Transaction.balanceChanges ?? [], signer.address);
  const outflowBoundMist = validated.spendAmountMist + cfg.maxGasBudgetMist;
  if (senderOutflowMist > outflowBoundMist) {
    throw new Error(
      `Simulated sender outflow ${senderOutflowMist} MIST exceeds the spend+gas bound ${outflowBoundMist} MIST `
        + `(spend ${validated.spendAmountMist} + gas ceiling ${cfg.maxGasBudgetMist}).`,
    );
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
