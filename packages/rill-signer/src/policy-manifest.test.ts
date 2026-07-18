import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import type { CapabilityManifest } from '../../rill-sdk/src/capability-manifest';
import { digestUnsignedPtb } from '../../rill-sdk/src/execution-envelope';
import type { EnvelopeStep, ExecutionEnvelope } from '../../rill-sdk/src/types';
import {
  assertCapabilitiesActive,
  inspectManifestGated,
  validateExecutionEnvelope,
  type LocalSignerPolicy,
} from './policy';
import { normalized, normalizeCoinType } from './steps/types';

// ── Manifest-gated signer policy: the REDESIGNED agent_wallet Rule + Hot Potato flow ──────────────
//
// `request_spend<T>(wallet, cap, version, amount, clock) -> SpendRequest` -> one `<module>::prove`
// per attached ON-CHAIN manifest rule (budget/per_tx/rate_limit/time_window, in manifest order) ->
// `confirm_spend<T>(wallet, req, version, clock) -> Coin<T>`, then the owner-approved `steps` fund
// from the released coin exactly like inspectGeneric. `protocol_scope`/`asset_scope`/
// `recipient_allowlist`/`slippage_floor` are PRE-FLIGHT rules the signer re-verifies independently
// from the actual PTB bytes (never trusting the backend's own pre-flight check) — see
// validateManifestEnvelope's "Signer-side manifest verification" block in policy.ts.
//
// This suite is entirely additive: it never touches a policy without `capabilityManifest`, so it
// cannot affect the legacy/generic paths' 187 pre-existing tests (see policy.test.ts /
// policy-generic.test.ts), which must keep passing unmodified.

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const walletPackageId = id(1);
const cetusPackageId = id(2);
const guardPackageId = id(3);
const sender = id(5);
const walletId = id(16);
const agentCapId = id(17);
const versionId = id(18);
const poolId = id(19);
const coinTypeSui = '0x2::sui::SUI';
const coinTypeUsdc = `${id(21)}::usdc::USDC`;
const foreignRecipient = id(90);
const offScopePackage = id(91);
const offScopeCoinType = `${id(92)}::fake::FAKE`;

const swapAmount = 100_000_000n;

// The per-step declared slippage floor (owner-approved plan) is intentionally LOWER than the
// manifest's wallet-level floor below, so a guard value that clears the step's own check but not the
// manifest's can be constructed — proving the manifest floor is enforced INDEPENDENTLY of, not merely
// redundantly with, the per-step floor cetusSwapStepValidator already checks (see cetus.ts).
const stepMinOutMist = 50_000n;
const manifestMinOutMist = 68_210n;

const steps: EnvelopeStep[] = [
  { nodeType: 'cetus_swap', poolId, minOutMist: stepMinOutMist.toString(), spendAmountMist: swapAmount.toString() },
];

// Two on-chain rules (budget, per_tx — neither takes a clock) plus all four pre-flight rules, so the
// full envelope round-trip suite below can exercise every pre-flight violation category in one shape.
const manifest: CapabilityManifest = {
  walletCoinType: coinTypeSui,
  rules: [
    { kind: 'budget', totalMist: '10000000000' },
    { kind: 'per_tx', maxMist: '5000000000' },
    { kind: 'protocol_scope', allowedPackages: [cetusPackageId, guardPackageId] },
    { kind: 'asset_scope', allowedCoinTypes: [coinTypeSui, coinTypeUsdc] },
    { kind: 'recipient_allowlist', addresses: [sender] },
    { kind: 'slippage_floor', minOutMist: manifestMinOutMist.toString() },
  ],
};

/**
 * Builds a compliant (or, via overrides, adversarial) manifest-gated PTB: request_spend ->
 * budget::prove -> per_tx::prove -> confirm_spend -> [cetus_swap fragment funded from the released
 * coin] -> optional transfer of the swap output -> merge-to-gas. Mirrors rill-backend's
 * compiler.service.ts `buildManifestGatedSpend` (request_spend/prove/confirm_spend shape) followed
 * by one owner-approved cetus_swap step (mirrors policy-generic.test.ts's buildTwoStepPtb pattern).
 */
function buildManifestGatedPtb(options: {
  amount?: bigint;
  skipProve?: 'budget' | 'per_tx';
  reorderProve?: boolean;
  proveArity?: number;
  wrongProveRequest?: boolean;
  omitConfirmSpend?: boolean;
  offScopeCall?: boolean;
  swapTypeArguments?: [string, string];
  minOutOverride?: bigint;
  transferSwapOutputTo?: string;
  omitMerge?: boolean;
} = {}): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const amount = options.amount ?? swapAmount;

  const req = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::request_spend`,
    typeArguments: [coinTypeSui],
    arguments: [
      tx.object(walletId),
      tx.object(agentCapId),
      tx.object(versionId),
      tx.pure.u64(amount),
      tx.object('0x6'),
    ],
  });

  const proveModules = options.reorderProve ? (['per_tx', 'budget'] as const) : (['budget', 'per_tx'] as const);
  for (const module of proveModules) {
    if (options.skipProve === module) continue;
    const fullArgs = [
      options.wrongProveRequest ? tx.pure.u64(0n) : req,
      tx.object(walletId),
      tx.object(versionId),
    ];
    const args = options.proveArity !== undefined ? fullArgs.slice(0, options.proveArity) : fullArgs;
    tx.moveCall({
      target: `${walletPackageId}::${module}::prove`,
      typeArguments: [coinTypeSui],
      arguments: args as never,
    });
  }

  if (options.omitConfirmSpend) return tx;

  const budgetCoin = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::confirm_spend`,
    typeArguments: [coinTypeSui],
    arguments: [tx.object(walletId), req, tx.object(versionId), tx.object('0x6')],
  });

  if (options.offScopeCall) {
    tx.moveCall({ target: `${offScopePackage}::evil::drain`, arguments: [] });
  }

  const swapTypeArgs = options.swapTypeArguments ?? [coinTypeSui, coinTypeUsdc];
  const [cetusCoin] = tx.splitCoins(budgetCoin, [amount]);
  const zeroCoin = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [swapTypeArgs[1]], arguments: [] });
  const [, outB] = tx.moveCall({
    target: `${cetusPackageId}::router::swap`,
    typeArguments: swapTypeArgs,
    arguments: [
      tx.object(id(9)),
      tx.object(poolId),
      cetusCoin,
      zeroCoin,
      tx.pure.bool(true),
      tx.pure.bool(true),
      tx.pure.u64(amount),
      tx.pure.u128(0n),
      tx.pure.bool(false),
      tx.object('0x6'),
    ],
  });
  tx.moveCall({
    target: `${guardPackageId}::guard::assert_min_value`,
    typeArguments: [swapTypeArgs[1]],
    arguments: [outB, tx.pure.u64(options.minOutOverride ?? manifestMinOutMist)],
  });

  if (options.transferSwapOutputTo) {
    tx.transferObjects([outB], options.transferSwapOutputTo);
  }

  if (!options.omitMerge) {
    tx.mergeCoins(tx.gas, [budgetCoin]);
  }

  return tx;
}

// ── inspectManifestGated: direct structural tests ─────────────────────────────────────────────────

test('inspectManifestGated validates a compliant redesigned-flow PTB and reports the right shape', () => {
  const tx = buildManifestGatedPtb();
  const result = inspectManifestGated(tx, { walletPackageId, walletId, agentCapId, versionId, steps, manifest });
  expect(result.spendAmountMist).toBe(swapAmount);
  expect(result.targets.sort()).toEqual(
    [
      `${normalized(cetusPackageId)}::router::swap`,
      `${normalized(guardPackageId)}::guard::assert_min_value`,
    ].sort(),
  );
  expect(result.guards).toEqual([`${normalized(guardPackageId)}::guard::assert_min_value`]);
  expect(result.objectIds.sort()).toEqual(
    [normalized(walletId), normalized(agentCapId), normalized(versionId), normalized('0x6'), normalized(poolId)].sort(),
  );
  expect(result.coinTypes.sort()).toEqual(
    [normalizeCoinType(coinTypeSui), normalizeCoinType(coinTypeUsdc)].sort(),
  );
  expect(result.transferRecipients).toEqual([]);
  expect(result.callTargets[0]).toBe(`${normalized(walletPackageId)}::agent_wallet::request_spend`);
});

test('inspectManifestGated rejects a PTB missing the wallet request_spend', () => {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeSui], arguments: [] });
  expect(() =>
    inspectManifestGated(tx, { walletPackageId, walletId, agentCapId, versionId, steps, manifest }),
  ).toThrow('missing the wallet request_spend');
});

test('inspectManifestGated rejects a PTB missing an on-chain rule prove call', () => {
  const tx = buildManifestGatedPtb({ skipProve: 'per_tx' });
  expect(() =>
    inspectManifestGated(tx, { walletPackageId, walletId, agentCapId, versionId, steps, manifest }),
  ).toThrow('missing ordered per_tx prove');
});

test('inspectManifestGated rejects prove calls out of manifest order', () => {
  const tx = buildManifestGatedPtb({ reorderProve: true });
  expect(() =>
    inspectManifestGated(tx, { walletPackageId, walletId, agentCapId, versionId, steps, manifest }),
  ).toThrow('missing ordered budget prove');
});

test("inspectManifestGated rejects a prove call that does not prove the wallet's own SpendRequest", () => {
  const tx = buildManifestGatedPtb({ wrongProveRequest: true });
  expect(() =>
    inspectManifestGated(tx, { walletPackageId, walletId, agentCapId, versionId, steps, manifest }),
  ).toThrow("does not prove the wallet's own SpendRequest");
});

test('inspectManifestGated rejects a PTB missing confirm_spend after its rule proofs', () => {
  const tx = buildManifestGatedPtb({ omitConfirmSpend: true });
  expect(() =>
    inspectManifestGated(tx, { walletPackageId, walletId, agentCapId, versionId, steps, manifest }),
  ).toThrow('missing the wallet confirm_spend');
});

test('inspectManifestGated rejects a PTB whose terminal command is not the merge-to-gas', () => {
  const tx = buildManifestGatedPtb({ omitMerge: true });
  expect(() =>
    inspectManifestGated(tx, { walletPackageId, walletId, agentCapId, versionId, steps, manifest }),
  ).toThrow('merging only the wallet spend remainder into gas');
});

test('inspectManifestGated requires a trailing clock argument on rate_limit/time_window prove calls', () => {
  const rateLimitManifest: CapabilityManifest = {
    walletCoinType: coinTypeSui,
    rules: [{ kind: 'rate_limit', windowMs: '3600000', maxMist: '5000000000' }],
  };
  const tx = new Transaction();
  tx.setSender(sender);
  const req = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::request_spend`,
    typeArguments: [coinTypeSui],
    arguments: [
      tx.object(walletId),
      tx.object(agentCapId),
      tx.object(versionId),
      tx.pure.u64(swapAmount),
      tx.object('0x6'),
    ],
  });
  // Missing the mandatory trailing clock argument on rate_limit::prove.
  tx.moveCall({
    target: `${walletPackageId}::rate_limit::prove`,
    typeArguments: [coinTypeSui],
    arguments: [req, tx.object(walletId), tx.object(versionId)],
  });
  expect(() =>
    inspectManifestGated(tx, {
      walletPackageId,
      walletId,
      agentCapId,
      versionId,
      steps: [],
      manifest: rateLimitManifest,
    }),
  ).toThrow('exactly 4 arguments');
});

// ── validateExecutionEnvelope (manifest-gated dispatch): full round-trip suite ───────────────────

function buildManifestPolicy(overrides: Partial<LocalSignerPolicy> = {}): LocalSignerPolicy {
  return {
    version: '1',
    actionId: 'skill_manifest_cetus',
    network: 'testnet',
    sender,
    walletPackageId,
    walletId,
    agentCapId,
    versionId,
    // Legacy-shaped fields LocalSignerPolicy still requires (the interface keeps every existing
    // field to back the legacy path) — unused by the manifest-gated branch, benign placeholders.
    balanceManagerId: id(50),
    tradeCapId: id(51),
    poolId,
    allowedTargets: [],
    requiredGuards: [`${guardPackageId}::guard::assert_min_value`],
    maxAmountMist: '10000000000',
    minimumRemainingMist: '0',
    demoParams: {
      poolKey: 'unused',
      price: 1,
      quantity: 1,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '1',
      depositSui: 1,
    },
    onChainOrder: {
      clientOrderId: '1',
      orderType: '0',
      selfMatchingOption: '0',
      price: '1',
      quantity: '1',
      isBid: false,
      payWithDeep: false,
      expiration: '1',
    },
    steps,
    capabilityManifest: manifest,
    ...overrides,
  };
}

const manifestPolicy = buildManifestPolicy();

async function buildManifestEnvelope(
  options: Parameters<typeof buildManifestGatedPtb>[0] & { stepsOverride?: EnvelopeStep[] } = {},
): Promise<ExecutionEnvelope> {
  const tx = buildManifestGatedPtb(options);
  const unsignedPtb = Buffer.from(tx.serialize()).toString('base64');
  return {
    version: '1',
    actionId: manifestPolicy.actionId,
    actionDigest: await digestUnsignedPtb(unsignedPtb),
    network: 'testnet',
    sender,
    walletPackageId,
    walletId,
    agentCapId,
    balanceManagerId: manifestPolicy.balanceManagerId,
    tradeCapId: manifestPolicy.tradeCapId,
    resolvedParams: {
      poolKey: 'unused',
      poolId,
      price: 1,
      quantity: 1,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '1',
      depositSui: 1,
      spendAmountMist: (options.amount ?? swapAmount).toString(),
    },
    allowedTargets: [],
    requiredObjectIds: [],
    requiredGuards: [...manifestPolicy.requiredGuards],
    unsignedPtb,
    preview: 'Manifest-gated Cetus swap',
    simulation: { ok: true, verification: 'verified', gasEstimate: 1, balanceChanges: [], objectChanges: [] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    steps: options.stepsOverride ?? steps,
  };
}

test('a compliant manifest-gated envelope validates', async () => {
  const result = await validateExecutionEnvelope(await buildManifestEnvelope(), sender, 'testnet', manifestPolicy);
  expect(result.spendAmountMist).toBe(swapAmount);
});

test('a manifest-gated envelope calling an off-allowlist package is rejected (protocol_scope)', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildManifestEnvelope({ offScopeCall: true }),
      sender,
      'testnet',
      manifestPolicy,
    ),
  ).rejects.toThrow('off-scope target');
});

test('a manifest-gated envelope moving an off-allowlist coin type is rejected (asset_scope)', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildManifestEnvelope({ swapTypeArguments: [coinTypeSui, offScopeCoinType] }),
      sender,
      'testnet',
      manifestPolicy,
    ),
  ).rejects.toThrow('off-scope coin type');
});

test('a manifest-gated envelope transferring to an off-allowlist recipient is rejected (recipient_allowlist)', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildManifestEnvelope({ transferSwapOutputTo: foreignRecipient }),
      sender,
      'testnet',
      manifestPolicy,
    ),
  ).rejects.toThrow('off-scope transfer recipient');
});

test('a manifest-gated envelope transferring to an allowlisted recipient is accepted', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildManifestEnvelope({ transferSwapOutputTo: sender }),
      sender,
      'testnet',
      manifestPolicy,
    ),
  ).resolves.toBeTruthy();
});

test(
  'a manifest-gated envelope whose swap clears the per-step floor but not the manifest slippage_floor is rejected',
  async () => {
    // stepMinOutMist (50_000) < this guard value (60_000) < manifestMinOutMist (68_210): the
    // per-step cetusSwapStepValidator check passes, proving the manifest-level check below is
    // independent enforcement, not a restatement of the step's own declared floor.
    await expect(
      validateExecutionEnvelope(
        await buildManifestEnvelope({ minOutOverride: 60_000n }),
        sender,
        'testnet',
        manifestPolicy,
      ),
    ).rejects.toThrow('manifest slippage floor');
  },
);

test('a manifest-gated envelope at exactly the manifest slippage_floor is accepted', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildManifestEnvelope({ minOutOverride: manifestMinOutMist }),
      sender,
      'testnet',
      manifestPolicy,
    ),
  ).resolves.toBeTruthy();
});

test('a manifest-gated policy with no versionId is rejected', async () => {
  const policyWithoutVersion = buildManifestPolicy({ versionId: undefined });
  await expect(
    validateExecutionEnvelope(await buildManifestEnvelope(), sender, 'testnet', policyWithoutVersion),
  ).rejects.toThrow('versionId');
});

// ── assertCapabilitiesActive (manifest-gated branch): no per_tx_max read ─────────────────────────

function manifestWalletReader(overrides: { budget?: string; revoked?: boolean; expiresAtMs?: string } = {}) {
  return {
    getObject: async ({ objectId }: { objectId: string }) => {
      if (normalized(objectId) === normalized(walletId)) {
        return {
          object: {
            owner: { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
            json: {
              budget: overrides.budget ?? '100000000000',
              revoked: overrides.revoked ?? false,
              agent: sender,
              expires_at_ms: overrides.expiresAtMs ?? '9999999999999',
              // Deliberately NO per_tx_max field — the redesigned wallet object has none (per_tx is
              // a Rule enforced on-chain by per_tx::prove, not a wallet field).
            },
          },
        };
      }
      if (normalized(objectId) === normalized(agentCapId)) {
        return { object: { owner: { $kind: 'AddressOwner', AddressOwner: sender }, json: { wallet: walletId } } };
      }
      throw new Error(`Unexpected getObject call for ${objectId} (only wallet/AgentCap expected here).`);
    },
  };
}

test(
  'assertCapabilitiesActive on a manifest-gated policy never reads per_tx_max (the redesigned wallet has no such field)',
  async () => {
    await expect(
      assertCapabilitiesActive(manifestWalletReader() as never, manifestPolicy, swapAmount),
    ).resolves.toBeUndefined();
  },
);

test('assertCapabilitiesActive on a manifest-gated policy still rejects a revoked wallet', async () => {
  await expect(
    assertCapabilitiesActive(manifestWalletReader({ revoked: true }) as never, manifestPolicy, swapAmount),
  ).rejects.toThrow('revoked');
});

test('assertCapabilitiesActive on a manifest-gated policy still rejects an expired wallet', async () => {
  await expect(
    assertCapabilitiesActive(manifestWalletReader({ expiresAtMs: '1' }) as never, manifestPolicy, swapAmount),
  ).rejects.toThrow('expired');
});

test('assertCapabilitiesActive on a manifest-gated policy still enforces the wallet cannot cover the spend', async () => {
  await expect(
    assertCapabilitiesActive(manifestWalletReader({ budget: '1' }) as never, manifestPolicy, swapAmount),
  ).rejects.toThrow('cannot cover');
});

test('assertCapabilitiesActive on a manifest-gated policy still enforces minimumRemainingMist', async () => {
  const strictPolicy = buildManifestPolicy({ minimumRemainingMist: '1' });
  await expect(
    assertCapabilitiesActive(
      manifestWalletReader({ budget: swapAmount.toString() }) as never,
      strictPolicy,
      swapAmount,
    ),
  ).rejects.toThrow('minimumRemainingMist');
});
