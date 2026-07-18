import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { injectMinOutAssert } from '../protocols/guard';
import { CETUS } from '../../core/protocols';
import { classifySimulation } from './simulator.service';

test('required min-out guard throws when package id is missing', () => {
  const tx = new Transaction();
  const coin = tx.moveCall({ target: '0x2::coin::zero', typeArguments: ['0x2::sui::SUI'] });
  expect(() => injectMinOutAssert(tx, coin, '0x2::sui::SUI', 1n, [], ''))
    .toThrow('RILL_GUARD_PACKAGE_ID is required');
});

// R3: the classifier now matches the Cetus package id + the `checked_package_version` context
// together, not a bare substring — this fixture uses a realistic package-qualified MoveAbort
// message (was a bare 'MoveAbort checked_package_version' with no package id, which the tightened
// classifier would no longer recognize as the known Cetus quirk; updated to actually exercise the
// package-matching path it's meant to test).
test('Cetus checked_package_version abort (real package id) stays failed and unverified', () => {
  const result = classifySimulation({
    ok: false,
    error: `MoveAbort(MoveLocation { module: ModuleId { address: ${CETUS.clmmPackageId}, name: `
      + `Identifier("config") }, function: 5, instruction: 3, function_name: `
      + `Some("checked_package_version") }, 1) in command 0`,
    gasEstimate: 0,
    balanceChanges: [],
    objectChanges: [],
  });
  expect(result.ok).toBe(false);
  expect(result.verification).toBe('unverified');
  expect(result.error).toContain('checked_package_version');
});

test('a lookalike checked_package_version abort from an unrelated package is NOT classified as the Cetus fallback (R3)', () => {
  const result = classifySimulation({
    ok: false,
    error: 'MoveAbort(MoveLocation { module: ModuleId { address: '
      + `0x${'de'.repeat(32)}, name: Identifier("config") }, function: 5, instruction: 3, `
      + 'function_name: Some("checked_package_version") }, 1) in command 0',
    gasEstimate: 0,
    balanceChanges: [],
    objectChanges: [],
  });
  expect(result.ok).toBe(false);
  // Not the known Cetus devInspect quirk (different package) — stays a genuine, plain failure
  // instead of being softened to "unverified".
  expect(result.verification).toBe('verified');
});
