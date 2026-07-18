import { expect, test } from 'bun:test';
import {
  CapabilityManifestSchema,
  toDeclaration,
  toOnChainRuleParams,
  toSignerPolicy,
  type CapabilityManifest,
} from '../src/capability-manifest';

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const USDC_MAINNET = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

/** A manifest carrying exactly one rule — the minimum valid manifest. */
function oneRuleManifest(rule: CapabilityManifest['rules'][number]): CapabilityManifest {
  return { walletCoinType: '0x2::sui::SUI', rules: [rule] };
}

/** All 8 rule kinds in one manifest — used for the round-trip / cross-projection tests. */
function fullManifest(): CapabilityManifest {
  return {
    walletCoinType: '0x2::sui::SUI',
    rules: [
      { kind: 'budget', totalMist: '5000000000' },
      { kind: 'per_tx', maxMist: '1000000000' },
      { kind: 'rate_limit', windowMs: '3600000', maxMist: '2000000000' },
      { kind: 'protocol_scope', allowedPackages: [hex(1), hex(2)] },
      { kind: 'slippage_floor', minBps: 50 },
      { kind: 'asset_scope', allowedCoinTypes: ['0x2::sui::SUI', USDC_MAINNET] },
      { kind: 'recipient_allowlist', addresses: [hex(3)] },
      { kind: 'time_window', notBeforeMs: '1700000000000', notAfterMs: '1800000000000' },
    ],
  };
}

// --- Each of the 8 rule kinds validates individually --------------------------------------------

test('a budget rule validates', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'budget', totalMist: '1000000000' }));
  expect(result.success).toBe(true);
});

test('a per_tx rule validates', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'per_tx', maxMist: '500000000' }));
  expect(result.success).toBe(true);
});

test('a rate_limit rule validates', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'rate_limit', windowMs: '60000', maxMist: '100000000' }),
  );
  expect(result.success).toBe(true);
});

test('a protocol_scope rule validates', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'protocol_scope', allowedPackages: [hex(1)] }),
  );
  expect(result.success).toBe(true);
});

test('a slippage_floor rule validates', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'slippage_floor', minBps: 50 }));
  expect(result.success).toBe(true);
});

test('an asset_scope rule validates', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'asset_scope', allowedCoinTypes: ['0x2::sui::SUI'] }),
  );
  expect(result.success).toBe(true);
});

test('a recipient_allowlist rule validates', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'recipient_allowlist', addresses: [hex(3)] }),
  );
  expect(result.success).toBe(true);
});

test('a time_window rule validates (both bounds present, ordered)', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'time_window', notBeforeMs: '1700000000000', notAfterMs: '1800000000000' }),
  );
  expect(result.success).toBe(true);
});

test('a time_window rule missing a bound is rejected (both are required, mirroring Move)', () => {
  const missingAfter = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'time_window', notBeforeMs: '1700000000000' } as CapabilityManifest['rules'][number]),
  );
  expect(missingAfter.success).toBe(false);
  const missingBefore = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'time_window', notAfterMs: '1800000000000' } as CapabilityManifest['rules'][number]),
  );
  expect(missingBefore.success).toBe(false);
});

test('a time_window rule with notBeforeMs >= notAfterMs is rejected (zero-width/inverted window)', () => {
  const inverted = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'time_window', notBeforeMs: '1800000000000', notAfterMs: '1700000000000' }),
  );
  expect(inverted.success).toBe(false);
  const zeroWidth = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'time_window', notBeforeMs: '1700000000000', notAfterMs: '1700000000000' }),
  );
  expect(zeroWidth.success).toBe(false);
  if (!zeroWidth.success) {
    expect(JSON.stringify(zeroWidth.error.issues)).toMatch(/strictly less/);
  }
});

test('the full 8-rule manifest validates', () => {
  const result = CapabilityManifestSchema.safeParse(fullManifest());
  expect(result.success).toBe(true);
});

// --- Unknown / duplicate kinds rejected ----------------------------------------------------------

test('an unrecognized rule kind is rejected', () => {
  const manifest = {
    walletCoinType: '0x2::sui::SUI',
    rules: [{ kind: 'budget', totalMist: '1000000000' }, { kind: 'unlimited_yolo', foo: 1 }],
  };
  const result = CapabilityManifestSchema.safeParse(manifest);
  expect(result.success).toBe(false);
});

test('a duplicate rule kind is rejected', () => {
  const manifest = {
    walletCoinType: '0x2::sui::SUI',
    rules: [
      { kind: 'budget', totalMist: '1000000000' },
      { kind: 'budget', totalMist: '2000000000' },
    ],
  };
  const result = CapabilityManifestSchema.safeParse(manifest);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(JSON.stringify(result.error.issues)).toMatch(/[Dd]uplicate/);
  }
});

// --- Empty rules array rejected (honest default: no restrictions = unsafe) -----------------------

test('an empty rules array is rejected with an honest "no restrictions" message', () => {
  const manifest = { walletCoinType: '0x2::sui::SUI', rules: [] };
  const result = CapabilityManifestSchema.safeParse(manifest);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(JSON.stringify(result.error.issues)).toMatch(/unsafe|no restrictions/i);
  }
});

// --- Bad u64 rejected -----------------------------------------------------------------------------

test('a decimal (non-integer) u64 string is rejected', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'budget', totalMist: '1.5' }));
  expect(result.success).toBe(false);
});

test('a negative u64 string is rejected', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'per_tx', maxMist: '-5' }));
  expect(result.success).toBe(false);
});

test('a u64 string exceeding the u64 maximum is rejected', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'rate_limit', windowMs: '60000', maxMist: '18446744073709551616' }),
  );
  expect(result.success).toBe(false);
});

test('a non-numeric u64 string is rejected', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'budget', totalMist: 'lots' }));
  expect(result.success).toBe(false);
});

// --- Bad Sui address rejected ----------------------------------------------------------------------

test('a protocol_scope address with no 0x prefix is rejected', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'protocol_scope', allowedPackages: ['deadbeef'] }),
  );
  expect(result.success).toBe(false);
});

test('a recipient_allowlist address with non-hex characters is rejected', () => {
  const result = CapabilityManifestSchema.safeParse(
    oneRuleManifest({ kind: 'recipient_allowlist', addresses: ['0xzzzz'] }),
  );
  expect(result.success).toBe(false);
});

test('an empty allowedPackages array is rejected (non-empty required)', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'protocol_scope', allowedPackages: [] }));
  expect(result.success).toBe(false);
});

test('an empty addresses array is rejected (non-empty required)', () => {
  const result = CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'recipient_allowlist', addresses: [] }));
  expect(result.success).toBe(false);
});

test('a slippage_floor minBps outside 0..10000 is rejected', () => {
  expect(CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'slippage_floor', minBps: -1 })).success).toBe(false);
  expect(CapabilityManifestSchema.safeParse(oneRuleManifest({ kind: 'slippage_floor', minBps: 10001 })).success).toBe(false);
});

// --- toOnChainRuleParams: witness + module + config per rule --------------------------------------

test('toOnChainRuleParams maps the full 8-rule manifest to expected witness/module/config', () => {
  const manifest = CapabilityManifestSchema.parse(fullManifest());
  const params = toOnChainRuleParams(manifest);
  expect(params).toEqual([
    { ruleWitness: 'BudgetRule', module: 'budget', config: { totalMist: 5000000000n } },
    { ruleWitness: 'PerTxRule', module: 'per_tx', config: { maxMist: 1000000000n } },
    { ruleWitness: 'RateLimitRule', module: 'rate_limit', config: { windowMs: 3600000n, maxMist: 2000000000n } },
    { ruleWitness: 'ProtocolScopeRule', module: 'protocol_scope', config: { allowedPackages: [hex(1), hex(2)] } },
    { ruleWitness: 'SlippageFloorRule', module: 'slippage_floor', config: { minBps: 50 } },
    {
      ruleWitness: 'AssetScopeRule',
      module: 'asset_scope',
      config: { allowedCoinTypes: ['0x2::sui::SUI', USDC_MAINNET] },
    },
    { ruleWitness: 'RecipientAllowlistRule', module: 'recipient_allowlist', config: { addresses: [hex(3)] } },
    {
      ruleWitness: 'TimeWindowRule',
      module: 'time_window',
      config: { notBeforeMs: 1700000000000n, notAfterMs: 1800000000000n },
    },
  ]);
});

test('toOnChainRuleParams emits both time_window bounds as bigint', () => {
  const manifest = CapabilityManifestSchema.parse(
    oneRuleManifest({ kind: 'time_window', notBeforeMs: '1000', notAfterMs: '2000' }),
  );
  const params = toOnChainRuleParams(manifest);
  expect(params).toEqual([
    { ruleWitness: 'TimeWindowRule', module: 'time_window', config: { notBeforeMs: 1000n, notAfterMs: 2000n } },
  ]);
});

// --- toSignerPolicy: flat shape -------------------------------------------------------------------

test('toSignerPolicy yields the agreed flat shape for the full 8-rule manifest', () => {
  const manifest = CapabilityManifestSchema.parse(fullManifest());
  const policy = toSignerPolicy(manifest);
  expect(policy).toEqual({
    maxAmountMist: '5000000000',
    perTxMaxMist: '1000000000',
    window: { windowMs: '3600000', maxMist: '2000000000' },
    allowedPackages: [hex(1), hex(2)],
    minSlippageBps: 50,
    allowedCoinTypes: ['0x2::sui::SUI', USDC_MAINNET],
    allowedRecipients: [hex(3)],
    timeWindow: { notBeforeMs: '1700000000000', notAfterMs: '1800000000000' },
  });
});

test('toSignerPolicy omits keys for rules not present in a mixed (partial) manifest', () => {
  const manifest = CapabilityManifestSchema.parse({
    walletCoinType: '0x2::sui::SUI',
    rules: [
      { kind: 'budget', totalMist: '3000000000' },
      { kind: 'slippage_floor', minBps: 25 },
    ],
  });
  const policy = toSignerPolicy(manifest);
  expect(policy).toEqual({ maxAmountMist: '3000000000', minSlippageBps: 25 });
});

// --- toDeclaration: human/agent-readable rendering per rule kind -----------------------------------

test('toDeclaration describes a budget rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(oneRuleManifest({ kind: 'budget', totalMist: '5000000000' }));
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toEqual(['Budget ≤ 5 SUI total']);
  expect(declaration.caps).toEqual([{ label: 'Budget', value: '5 SUI' }]);
});

test('toDeclaration describes a per_tx rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(oneRuleManifest({ kind: 'per_tx', maxMist: '1000000000' }));
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toEqual(['Per-transaction ≤ 1 SUI']);
  expect(declaration.caps).toEqual([{ label: 'Per-tx max', value: '1 SUI' }]);
});

test('toDeclaration describes a rate_limit rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(
    oneRuleManifest({ kind: 'rate_limit', windowMs: '3600000', maxMist: '2000000000' }),
  );
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toEqual(['≤ 2 SUI per 1h window']);
  expect(declaration.caps).toEqual([{ label: 'Rate limit', value: '2 SUI / 1h' }]);
});

test('toDeclaration describes a protocol_scope rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(
    oneRuleManifest({ kind: 'protocol_scope', allowedPackages: [hex(1), hex(2)] }),
  );
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toEqual([`Only protocols: ${hex(1)}, ${hex(2)}`]);
  expect(declaration.caps).toEqual([{ label: 'Allowed protocols', value: `${hex(1)}, ${hex(2)}` }]);
});

test('toDeclaration describes a slippage_floor rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(oneRuleManifest({ kind: 'slippage_floor', minBps: 50 }));
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toEqual(['Slippage floor 50 bps']);
  expect(declaration.caps).toEqual([{ label: 'Slippage floor', value: '50 bps' }]);
});

test('toDeclaration describes an asset_scope rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(
    oneRuleManifest({ kind: 'asset_scope', allowedCoinTypes: ['0x2::sui::SUI', USDC_MAINNET] }),
  );
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toEqual([`Only coins: 0x2::sui::SUI, ${USDC_MAINNET}`]);
  expect(declaration.caps).toEqual([{ label: 'Allowed coins', value: `0x2::sui::SUI, ${USDC_MAINNET}` }]);
});

test('toDeclaration describes a recipient_allowlist rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(oneRuleManifest({ kind: 'recipient_allowlist', addresses: [hex(3)] }));
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toEqual([`Only recipients: ${hex(3)}`]);
  expect(declaration.caps).toEqual([{ label: 'Allowed recipients', value: hex(3) }]);
});

test('toDeclaration describes a time_window rule in plain language', () => {
  const manifest = CapabilityManifestSchema.parse(
    oneRuleManifest({ kind: 'time_window', notBeforeMs: '1700000000000', notAfterMs: '1800000000000' }),
  );
  const declaration = toDeclaration(manifest);
  const expectedValue = 'not before 2023-11-14T22:13:20.000Z; not after 2027-01-15T08:00:00.000Z';
  expect(declaration.summaryLines).toEqual([`Time window: ${expectedValue}`]);
  expect(declaration.caps).toEqual([{ label: 'Time window', value: expectedValue }]);
});

test('toDeclaration renders one summary line and one cap per rule, for all 8 kinds, in manifest order', () => {
  const manifest = CapabilityManifestSchema.parse(fullManifest());
  const declaration = toDeclaration(manifest);
  expect(declaration.summaryLines).toHaveLength(8);
  expect(declaration.caps).toHaveLength(8);
  expect(declaration.caps.map((c) => c.label)).toEqual([
    'Budget',
    'Per-tx max',
    'Rate limit',
    'Allowed protocols',
    'Slippage floor',
    'Allowed coins',
    'Allowed recipients',
    'Time window',
  ]);
});

// --- Round trip: full 8-rule manifest projects losslessly across all 3 layers ---------------------

test('a full 8-rule manifest round-trips through all 3 projections without losing fields that matter', () => {
  const manifest = CapabilityManifestSchema.parse(fullManifest());
  const onChain = toOnChainRuleParams(manifest);
  const signerPolicy = toSignerPolicy(manifest);
  const declaration = toDeclaration(manifest);

  // Same rule count reflected everywhere.
  expect(onChain).toHaveLength(8);
  expect(declaration.caps).toHaveLength(8);

  // Budget: on-chain bigint, signer string, declaration text all agree it's 5 SUI / 5000000000 mist.
  expect(onChain.find((p) => p.module === 'budget')?.config).toEqual({ totalMist: 5000000000n });
  expect(signerPolicy.maxAmountMist).toBe('5000000000');
  expect(declaration.caps.find((c) => c.label === 'Budget')?.value).toContain('5 SUI');

  // protocol_scope addresses agree across on-chain config and signer policy.
  expect(onChain.find((p) => p.module === 'protocol_scope')?.config).toEqual({ allowedPackages: [hex(1), hex(2)] });
  expect(signerPolicy.allowedPackages).toEqual([hex(1), hex(2)]);

  // recipient_allowlist addresses agree across on-chain config and signer policy.
  expect(onChain.find((p) => p.module === 'recipient_allowlist')?.config).toEqual({ addresses: [hex(3)] });
  expect(signerPolicy.allowedRecipients).toEqual([hex(3)]);

  // slippage_floor bps agree across on-chain config, signer policy, and declaration.
  expect(onChain.find((p) => p.module === 'slippage_floor')?.config).toEqual({ minBps: 50 });
  expect(signerPolicy.minSlippageBps).toBe(50);
  expect(declaration.caps.find((c) => c.label === 'Slippage floor')?.value).toBe('50 bps');
});
