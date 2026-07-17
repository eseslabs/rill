import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { ValidationError } from '../../core/errors';
import { ptbAdapter } from './ptb.adapter';
import type { AdapterCtx } from './types';

function ctx(ptbNodeCount: number): AdapterCtx {
  const nodes = Array.from({ length: ptbNodeCount }, (_, i) => ({
    id: `ptb${i}`,
    type: 'ptb',
    config: {},
  }));
  return {
    tx: new Transaction(),
    node: nodes[0],
    flow: { nodes, edges: [] },
    nodeOutputs: {},
    warnings: [],
  } as unknown as AdapterCtx;
}

test('one PTB node is accepted as a transaction-boundary marker', async () => {
  const c = ctx(1);
  await ptbAdapter.build(c);
  expect(c.warnings).toEqual([]);
});

test('two PTB nodes are rejected, not warned about', async () => {
  expect(ptbAdapter.build(ctx(2))).rejects.toThrow(ValidationError);
});

test('the rejection explains that a flow compiles to exactly one PTB', async () => {
  expect(ptbAdapter.build(ctx(3))).rejects.toThrow(/exactly one/i);
});
