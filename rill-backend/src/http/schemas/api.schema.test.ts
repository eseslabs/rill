import { expect, test } from 'bun:test';
import {
  AgentWalletSchema,
  CompileSchema,
  ExecuteSchema,
  IntrospectSchema,
  SetupPrepareSchema,
  SimulateSchema,
} from './api.schema';

const validSender = `0x${'1'.repeat(64)}`;
const validWallet = {
  packageId: `0x${'2'.repeat(64)}`,
  walletId: `0x${'3'.repeat(64)}`,
  capId: `0x${'4'.repeat(64)}`,
};

// --- Sui-address regex refinements (R13) ------------------------------------

test('CompileSchema rejects a garbage sender ("zz") with a 422-worthy Zod issue', () => {
  const result = CompileSchema.safeParse({
    flow: { nodes: [], edges: [] },
    sender: 'zz',
  });
  expect(result.success).toBe(false);
});

test('CompileSchema accepts a well-formed hex sender', () => {
  const result = CompileSchema.safeParse({
    flow: { nodes: [], edges: [] },
    sender: validSender,
  });
  expect(result.success).toBe(true);
});

test('CompileSchema still accepts an absent (optional) sender', () => {
  const result = CompileSchema.safeParse({ flow: { nodes: [], edges: [] } });
  expect(result.success).toBe(true);
});

test('SimulateSchema rejects a garbage sender the same way', () => {
  const result = SimulateSchema.safeParse({
    flow: { nodes: [], edges: [] },
    sender: 'not-an-address',
  });
  expect(result.success).toBe(false);
});

test('ExecuteSchema rejects a garbage sender (required field)', () => {
  const result = ExecuteSchema.safeParse({
    skillId: 'skill_1',
    sender: 'zz',
    agentWallet: validWallet,
  });
  expect(result.success).toBe(false);
});

test('ExecuteSchema accepts a well-formed request', () => {
  const result = ExecuteSchema.safeParse({
    skillId: 'skill_1',
    sender: validSender,
    agentWallet: validWallet,
  });
  expect(result.success).toBe(true);
});

test('SetupPrepareSchema rejects a garbage sender', () => {
  const result = SetupPrepareSchema.safeParse({
    skillId: 'skill_1',
    sender: 'zz',
    budgetMist: '1000000000',
    perTxMist: '100000000',
  });
  expect(result.success).toBe(false);
});

test('SetupPrepareSchema accepts a well-formed request (including a short-form address)', () => {
  const result = SetupPrepareSchema.safeParse({
    skillId: 'skill_1',
    sender: validSender,
    budgetMist: '1000000000',
    perTxMist: '100000000',
  });
  expect(result.success).toBe(true);
});

test('AgentWalletSchema rejects a non-hex packageId/walletId/capId', () => {
  expect(AgentWalletSchema.safeParse({ ...validWallet, packageId: 'zz' }).success).toBe(false);
  expect(AgentWalletSchema.safeParse({ ...validWallet, walletId: 'not-hex' }).success).toBe(false);
  expect(AgentWalletSchema.safeParse({ ...validWallet, capId: '' }).success).toBe(false);
});

test('AgentWalletSchema accepts a short-form address like "0x2"', () => {
  const result = AgentWalletSchema.safeParse({ packageId: '0x2', walletId: '0x2', capId: '0x2' });
  expect(result.success).toBe(true);
});

// --- F7: optional capabilityManifest + versionId (manifest-gated redesigned package) ------------

const validManifest = {
  walletCoinType: '0x2::sui::SUI',
  rules: [{ kind: 'budget', totalMist: '5000000000' }],
};

test('AgentWalletSchema accepts a valid capabilityManifest + versionId alongside the existing fields', () => {
  const result = AgentWalletSchema.safeParse({
    ...validWallet,
    versionId: `0x${'5'.repeat(64)}`,
    capabilityManifest: validManifest,
  });
  expect(result.success).toBe(true);
});

test('AgentWalletSchema still accepts a request with no capabilityManifest/versionId (v2, unchanged)', () => {
  const result = AgentWalletSchema.safeParse(validWallet);
  expect(result.success).toBe(true);
  if (result.success) {
    expect('capabilityManifest' in result.data).toBe(false);
    expect('versionId' in result.data).toBe(false);
  }
});

test('AgentWalletSchema rejects a non-hex versionId', () => {
  const result = AgentWalletSchema.safeParse({ ...validWallet, versionId: 'not-hex', capabilityManifest: validManifest });
  expect(result.success).toBe(false);
});

test('AgentWalletSchema rejects an invalid capabilityManifest (KTD-6: empty rules means unlimited spend)', () => {
  const result = AgentWalletSchema.safeParse({
    ...validWallet,
    versionId: `0x${'5'.repeat(64)}`,
    capabilityManifest: { walletCoinType: '0x2::sui::SUI', rules: [] },
  });
  expect(result.success).toBe(false);
});

test('IntrospectSchema rejects a garbage packageId', () => {
  expect(IntrospectSchema.safeParse({ packageId: 'zz' }).success).toBe(false);
});

test('IntrospectSchema accepts a well-formed packageId', () => {
  expect(IntrospectSchema.safeParse({ packageId: `0x${'a'.repeat(64)}` }).success).toBe(true);
});

// --- useServerWallet opt-in flag (R13) --------------------------------------------------------

test('CompileSchema and SimulateSchema accept an optional useServerWallet flag', () => {
  expect(CompileSchema.safeParse({ flow: { nodes: [], edges: [] }, useServerWallet: true }).success).toBe(true);
  expect(SimulateSchema.safeParse({ flow: { nodes: [], edges: [] }, useServerWallet: false }).success).toBe(true);
});

test('CompileSchema and SimulateSchema still accept an absent (optional) useServerWallet', () => {
  expect(CompileSchema.safeParse({ flow: { nodes: [], edges: [] } }).success).toBe(true);
  expect(SimulateSchema.safeParse({ flow: { nodes: [], edges: [] } }).success).toBe(true);
});

test('CompileSchema rejects a non-boolean useServerWallet', () => {
  const result = CompileSchema.safeParse({ flow: { nodes: [], edges: [] }, useServerWallet: 'true' });
  expect(result.success).toBe(false);
});
