import { expect, test } from 'bun:test';
import path from 'node:path';
import { assertBootSafe, config } from './config';

// `process.env.SUI_NETWORK` is read once at module load and this repo ships no committed `.env`
// (only `.env.example`), so the test process boots with it unset — pins the fallback (R7/KTD-7).
test('default network is testnet when SUI_NETWORK is unset', () => {
  expect(config.network).toBe('testnet');
});

test('testnet ships a known guard package id by default', () => {
  expect(config.guardPackageId).toBeTruthy();
});

test('skillsStorePath is an absolute path anchored at the backend package root, not cwd', () => {
  expect(path.isAbsolute(config.skillsStorePath)).toBe(true);
  expect(config.skillsStorePath).toBe(path.resolve(import.meta.dir, '..', '..', 'data', 'skills.json'));
});

// `assertBootSafe` is the extracted, directly-testable half of the fail-fast startup guard —
// `config.ts` also calls it once at module load against the real env, which is what makes the
// process itself refuse to boot; re-triggering that module-load call under a different
// `SUI_NETWORK` isn't practical from a test (env is only read once), so this exercises the pure
// function directly instead (KTD-7).
test('boot guard throws a clear, actionable error on mainnet without a guard package id', () => {
  expect(() => assertBootSafe({ network: 'mainnet', guardPackageId: undefined })).toThrow(
    /RILL_GUARD_PACKAGE_ID/,
  );
  expect(() => assertBootSafe({ network: 'mainnet', guardPackageId: '' })).toThrow(
    /RILL_GUARD_PACKAGE_ID/,
  );
});

test('boot guard passes on mainnet when a guard package id is configured', () => {
  expect(() => assertBootSafe({ network: 'mainnet', guardPackageId: '0xabc' })).not.toThrow();
});

test('boot guard passes on testnet even without a guard package id (dev default)', () => {
  expect(() => assertBootSafe({ network: 'testnet', guardPackageId: undefined })).not.toThrow();
});
