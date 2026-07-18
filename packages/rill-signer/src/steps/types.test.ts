import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { makeReader } from './types';

test('reader decodes a u64 pure argument', () => {
  const tx = new Transaction();
  tx.moveCall({ target: `0x${'2'.padStart(64,'0')}::m::f`, arguments: [tx.pure.u64(42n)] });
  const data = tx.getData();
  const reader = makeReader(data);
  const call = data.commands[0] as { MoveCall: { arguments: unknown[] } };
  expect(reader.u64(call.MoveCall.arguments[0], 'x')).toBe(42n);
});

test('reader rejects a non-u64 as a u64', () => {
  const tx = new Transaction();
  tx.moveCall({ target: `0x${'2'.padStart(64,'0')}::m::f`, arguments: [tx.pure.bool(true)] });
  const data = tx.getData();
  const reader = makeReader(data);
  const call = data.commands[0] as { MoveCall: { arguments: unknown[] } };
  expect(() => reader.u64(call.MoveCall.arguments[0], 'x')).toThrow(/not a u64/);
});
