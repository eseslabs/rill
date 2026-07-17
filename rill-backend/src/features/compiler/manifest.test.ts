import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { deriveCallManifest } from './manifest';

const PKG = `0x${'ab'.repeat(32)}`;

test('an empty transaction yields an empty manifest', () => {
  expect(deriveCallManifest(new Transaction())).toEqual([]);
});

test('a move call is reported with its target and type arguments', () => {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::router::swap`,
    typeArguments: ['0x2::sui::SUI', `${PKG}::usdc::USDC`],
    arguments: [tx.pure.u64(42n)],
  });

  const manifest = deriveCallManifest(tx);

  expect(manifest).toHaveLength(1);
  expect(manifest[0]!.index).toBe(0);
  expect(manifest[0]!.target).toBe(`${PKG}::router::swap`);
  expect(manifest[0]!.typeArguments).toEqual(['0x2::sui::SUI', `${PKG}::usdc::USDC`]);
});

test('u64 pure arguments are decoded from the bytes in argument order', () => {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::router::swap`,
    arguments: [tx.pure.u64(100n), tx.pure.u64(7n)],
  });

  expect(deriveCallManifest(tx)[0]!.u64Args).toEqual(['100', '7']);
});

test('non-move-call commands are skipped but do not shift the reported index', () => {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1n)]);
  tx.moveCall({ target: `${PKG}::router::swap`, arguments: [coin!] });

  const manifest = deriveCallManifest(tx);

  expect(manifest).toHaveLength(1);
  expect(manifest[0]!.index).toBe(1);
});
