import { expect, test } from 'bun:test';
import { classifySimulation } from './simulator.service';

const base = { gasEstimate: 0, balanceChanges: [], objectChanges: [] };

test('a successful simulation is verified', () => {
  expect(classifySimulation({ ...base, ok: true }).verification).toBe('verified');
});

test('a failed simulation is never labelled verified', () => {
  expect(classifySimulation({ ...base, ok: false, error: 'Insufficient gas' }).verification).toBe('failed');
});

test('an RPC outage is never labelled verified', () => {
  expect(
    classifySimulation({ ...base, ok: false, error: 'fetch failed: ECONNREFUSED' }).verification,
  ).toBe('failed');
});

test('the known Cetus devInspect version abort stays unverified, not failed', () => {
  expect(
    classifySimulation({
      ...base,
      ok: false,
      error: 'MoveAbort in checked_package_version at offset 3',
    }).verification,
  ).toBe('unverified');
});
