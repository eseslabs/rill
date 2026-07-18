import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRunSets, runSetsDir, saveRunSet } from './runsets';

let originalConfigDir: string | undefined;
let tempConfigDir: string;

beforeEach(() => {
  originalConfigDir = process.env.RILL_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), 'rill-runsets-test-'));
  process.env.RILL_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RILL_CONFIG_DIR;
  else process.env.RILL_CONFIG_DIR = originalConfigDir;
  rmSync(tempConfigDir, { recursive: true, force: true });
});

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const runSet = {
  version: '1' as const,
  label: 'test_set',
  actionId: 'skill_deepbook',
  network: 'testnet' as const,
  sender: id(1),
  walletPackageId: id(2),
  walletId: id(3),
  agentCapId: id(4),
  balanceManagerId: id(5),
  tradeCapId: id(6),
  poolId: id(7),
  allowedTargets: [],
  requiredGuards: [],
  maxAmountMist: '10000000',
  minimumRemainingMist: '20000000',
  demoParams: {
    poolKey: 'SUI_DBUSDC',
    price: 1,
    quantity: 0.005,
    isBid: false,
    payWithDeep: false,
    clientOrderId: '71601',
    depositSui: 0.006,
  },
  onChainOrder: {
    clientOrderId: '71601',
    orderType: '0',
    selfMatchingOption: '0',
    price: '1000000',
    quantity: '5000000',
    isBid: false,
    payWithDeep: false,
    expiration: '1844674407370955161',
  },
};

test('listRunSets returns an empty array when the directory is missing', () => {
  expect(listRunSets()).toEqual([]);
});

test('saveRunSet and listRunSets round-trip run-sets', () => {
  saveRunSet('test_set', runSet);
  expect(listRunSets()).toEqual([runSet]);
  expect(listRunSets('mainnet')).toEqual([]);
  expect(listRunSets('testnet')).toEqual([runSet]);
});

test('saveRunSet sanitizes unsafe label characters in the filename', () => {
  const unsafeLabel = 'set/with:bad';
  saveRunSet(unsafeLabel, { ...runSet, label: unsafeLabel });
  const sets = listRunSets();
  expect(sets).toHaveLength(1);
  expect(sets[0].label).toBe(unsafeLabel);
});
