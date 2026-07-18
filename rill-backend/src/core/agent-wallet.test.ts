import { afterEach, beforeEach, expect, test } from 'bun:test';
import { normalizeAgentWallet, SUI_COIN_TYPE } from './agent-wallet';
import { ValidationError } from './errors';
import { compilerService } from '../features/compiler/compiler.service';
import type { CapabilityManifest } from '../../../packages/rill-sdk/src/capability-manifest';

/**
 * F7: coverage for `normalizeAgentWallet` — the single place that resolves a raw agentWallet input
 * (from HTTP's `AgentWalletSchema`, MCP's `readAgentWallet`, or any other caller) into a full
 * `AgentWalletBinding`, and decides which of the two coexisting agent_wallet packages it targets.
 * See `features/compiler/compiler.service.test.ts` for exhaustive coverage of the redesigned
 * request_spend/prove/confirm_spend PTB SHAPE once a manifest-carrying binding reaches the compiler
 * — the tests below are about the WIRING: that a raw input actually resolves to the binding the
 * compiler expects, env fallback included, and that both packages keep coexisting end to end.
 */

const objectId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const V2_PACKAGE = objectId(2);
const REDESIGNED_PACKAGE = objectId(3);
const VERSION_ID = objectId(4);
const WALLET_ID = objectId(5);
const CAP_ID = objectId(6);
const sender = objectId(7);
const OTHER_PACKAGE = objectId(8);

const budgetManifest: CapabilityManifest = {
  walletCoinType: SUI_COIN_TYPE,
  rules: [{ kind: 'budget', totalMist: '5000000000' }],
};

let originalRedesigned: string | undefined;
let originalVersion: string | undefined;

beforeEach(() => {
  originalRedesigned = process.env.AGENT_WALLET_PACKAGE_ID_REDESIGNED;
  originalVersion = process.env.AGENT_WALLET_VERSION_ID;
  delete process.env.AGENT_WALLET_PACKAGE_ID_REDESIGNED;
  delete process.env.AGENT_WALLET_VERSION_ID;
});

afterEach(() => {
  if (originalRedesigned === undefined) delete process.env.AGENT_WALLET_PACKAGE_ID_REDESIGNED;
  else process.env.AGENT_WALLET_PACKAGE_ID_REDESIGNED = originalRedesigned;
  if (originalVersion === undefined) delete process.env.AGENT_WALLET_VERSION_ID;
  else process.env.AGENT_WALLET_VERSION_ID = originalVersion;
});

const HAEDAL_STAKE_TARGET = `${objectId(300)}::interface::request_stake`;
const HAEDAL_SUI_SYSTEM_STATE = objectId(301);
const HAEDAL_STAKING_OBJECT = objectId(302);

function haedalStakeNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'haedal_stake',
    config: {
      stakeTarget: HAEDAL_STAKE_TARGET,
      suiSystemStateId: HAEDAL_SUI_SYSTEM_STATE,
      stakingObjectId: HAEDAL_STAKING_OBJECT,
      amount: '1000000000',
      minStakeMist: '1000000000',
      validator: objectId(303),
      ...overrides,
    },
  };
}

function moveCallTargets(transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction']) {
  return transaction.getData().commands.map((command) =>
    command.$kind === 'MoveCall'
      ? `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`
      : '',
  );
}

// --- normalizeAgentWallet: pure resolution logic -----------------------------------------------

test('a manifest-less input normalizes to the v2 binding, unchanged, with no manifest/versionId carried', () => {
  const result = normalizeAgentWallet({ packageId: V2_PACKAGE, walletId: WALLET_ID, capId: CAP_ID });

  expect(result).toEqual({
    packageId: V2_PACKAGE,
    walletId: WALLET_ID,
    capId: CAP_ID,
    coinType: SUI_COIN_TYPE,
  });
  expect('capabilityManifest' in result).toBe(false);
  expect('versionId' in result).toBe(false);
});

test('a manifest-less input honors an explicit coinType instead of defaulting to SUI', () => {
  const usdc = `${objectId(900)}::usdc::USDC`;
  const result = normalizeAgentWallet({ packageId: V2_PACKAGE, walletId: WALLET_ID, capId: CAP_ID, coinType: usdc });
  expect(result.coinType).toBe(usdc);
});

test('a manifest-less input missing packageId -> ValidationError (no env fallback for v2)', () => {
  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID })).toThrow(ValidationError);
  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID })).toThrow(/agentWallet.packageId is required/);
});

test('an input WITH capabilityManifest + explicit packageId/versionId normalizes to a binding carrying both, untouched by env', () => {
  const result = normalizeAgentWallet({
    packageId: REDESIGNED_PACKAGE,
    walletId: WALLET_ID,
    capId: CAP_ID,
    versionId: VERSION_ID,
    capabilityManifest: budgetManifest,
  });

  expect(result).toEqual({
    packageId: REDESIGNED_PACKAGE,
    walletId: WALLET_ID,
    capId: CAP_ID,
    coinType: SUI_COIN_TYPE,
    versionId: VERSION_ID,
    capabilityManifest: budgetManifest,
  });
});

test('an input WITH capabilityManifest but no packageId/versionId falls back to AGENT_WALLET_PACKAGE_ID_REDESIGNED / AGENT_WALLET_VERSION_ID', () => {
  process.env.AGENT_WALLET_PACKAGE_ID_REDESIGNED = REDESIGNED_PACKAGE;
  process.env.AGENT_WALLET_VERSION_ID = VERSION_ID;

  const result = normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID, capabilityManifest: budgetManifest });

  expect(result.packageId).toBe(REDESIGNED_PACKAGE);
  expect(result.versionId).toBe(VERSION_ID);
  expect(result.capabilityManifest).toEqual(budgetManifest);
});

test('an input WITH capabilityManifest and its own packageId still falls back to AGENT_WALLET_VERSION_ID for versionId', () => {
  process.env.AGENT_WALLET_VERSION_ID = VERSION_ID;

  const result = normalizeAgentWallet({
    packageId: REDESIGNED_PACKAGE,
    walletId: WALLET_ID,
    capId: CAP_ID,
    capabilityManifest: budgetManifest,
  });

  expect(result.packageId).toBe(REDESIGNED_PACKAGE);
  expect(result.versionId).toBe(VERSION_ID);
});

test('a manifest present but neither packageId nor AGENT_WALLET_PACKAGE_ID_REDESIGNED resolvable -> ValidationError', () => {
  process.env.AGENT_WALLET_VERSION_ID = VERSION_ID; // version resolvable; package is not

  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID, capabilityManifest: budgetManifest }))
    .toThrow(ValidationError);
  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID, capabilityManifest: budgetManifest }))
    .toThrow(/requires the redesigned agent_wallet package id/);
});

test('a manifest present but neither versionId nor AGENT_WALLET_VERSION_ID resolvable -> ValidationError', () => {
  process.env.AGENT_WALLET_PACKAGE_ID_REDESIGNED = REDESIGNED_PACKAGE; // package resolvable; version is not

  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID, capabilityManifest: budgetManifest }))
    .toThrow(ValidationError);
  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID, capabilityManifest: budgetManifest }))
    .toThrow(/requires the shared agent_wallet Version object id/);
});

test('a manifest present but neither package nor version resolvable anywhere -> ValidationError (fails on packageId first)', () => {
  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID, capabilityManifest: budgetManifest }))
    .toThrow(/requires the redesigned agent_wallet package id/);
});

// --- End-to-end: normalizeAgentWallet -> compileFlow (the actual F7 wiring) ---------------------

test('a normalized manifest binding compiles the redesigned request_spend/prove/confirm_spend sequence, never legacy spend()', async () => {
  const agentWallet = normalizeAgentWallet({
    packageId: REDESIGNED_PACKAGE,
    walletId: WALLET_ID,
    capId: CAP_ID,
    versionId: VERSION_ID,
    capabilityManifest: budgetManifest,
  });

  const flow = { nodes: [haedalStakeNode('h1')], edges: [] };
  const result = await compilerService.compileFlow(flow, { sender, agentWallet });
  const targets = moveCallTargets(result.transaction);

  expect(targets).toContain(`${REDESIGNED_PACKAGE}::agent_wallet::request_spend`);
  expect(targets).toContain(`${REDESIGNED_PACKAGE}::budget::prove`);
  expect(targets).toContain(`${REDESIGNED_PACKAGE}::agent_wallet::confirm_spend`);
  expect(targets).not.toContain(`${REDESIGNED_PACKAGE}::agent_wallet::spend`);
  expect(targets.some((t) => t.endsWith('::request_stake'))).toBe(true); // the flow's own action still compiled
});

test('a normalized manifest-less binding still compiles the legacy spend() call — v2/redesigned coexistence', async () => {
  const agentWallet = normalizeAgentWallet({ packageId: V2_PACKAGE, walletId: WALLET_ID, capId: CAP_ID });

  const flow = { nodes: [haedalStakeNode('h1')], edges: [] };
  const result = await compilerService.compileFlow(flow, { sender, agentWallet });
  const targets = moveCallTargets(result.transaction);

  expect(targets).toContain(`${V2_PACKAGE}::agent_wallet::spend`);
  expect(targets.some((t) => t.includes('request_spend'))).toBe(false);
  expect(targets.some((t) => t.includes('confirm_spend'))).toBe(false);
  expect(targets.some((t) => t.endsWith('::prove'))).toBe(false);
});

test('a normalized manifest binding actually runs enforceManifestPreflight — a protocol_scope violation still rejects with 422', async () => {
  const scopedManifest: CapabilityManifest = {
    walletCoinType: SUI_COIN_TYPE,
    rules: [
      { kind: 'budget', totalMist: '5000000000' },
      { kind: 'protocol_scope', allowedPackages: [OTHER_PACKAGE] }, // not Haedal's package
    ],
  };
  const agentWallet = normalizeAgentWallet({
    packageId: REDESIGNED_PACKAGE,
    walletId: WALLET_ID,
    capId: CAP_ID,
    versionId: VERSION_ID,
    capabilityManifest: scopedManifest,
  });

  const flow = { nodes: [haedalStakeNode('h1')], edges: [] };
  await expect(compilerService.compileFlow(flow, { sender, agentWallet })).rejects.toThrow(ValidationError);
  await expect(compilerService.compileFlow(flow, { sender, agentWallet })).rejects.toThrow(/protocol_scope violation/);
});

test('an unresolved manifest binding never reaches the compiler at all — normalizeAgentWallet fails closed first', () => {
  // No packageId/versionId on the input, and no env fallback configured (beforeEach clears both) —
  // this must throw during normalization, before compileFlow (and therefore before any PTB command)
  // is ever invoked.
  expect(() => normalizeAgentWallet({ walletId: WALLET_ID, capId: CAP_ID, capabilityManifest: budgetManifest }))
    .toThrow(ValidationError);
});
