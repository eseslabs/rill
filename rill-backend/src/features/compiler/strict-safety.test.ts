import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { injectMinOutAssert } from '../protocols/guard';
import { classifySimulation } from './simulator.service';

test('required min-out guard throws when package id is missing', () => {
  const tx = new Transaction();
  const coin = tx.moveCall({ target: '0x2::coin::zero', typeArguments: ['0x2::sui::SUI'] });
  expect(() => injectMinOutAssert(tx, coin, '0x2::sui::SUI', 1n, [], ''))
    .toThrow('RILL_GUARD_PACKAGE_ID is required');
});

test('checked_package_version remains failed and unverified', () => {
  const result = classifySimulation({
    ok: false,
    error: 'MoveAbort checked_package_version',
    gasEstimate: 0,
    balanceChanges: [],
    objectChanges: [],
  });
  expect(result.ok).toBe(false);
  expect(result.verification).toBe('unverified');
  expect(result.error).toContain('checked_package_version');
});
