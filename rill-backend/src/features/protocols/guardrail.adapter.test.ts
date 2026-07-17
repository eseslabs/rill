import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { ValidationError } from '../../core/errors';
import { guardrailAdapter } from './guardrail.adapter';
import type { AdapterCtx } from './types';

function ctx(overrides: Partial<AdapterCtx>): AdapterCtx {
  const tx = new Transaction();
  return {
    tx,
    node: { id: 'g1', type: 'guardrail', config: { minValue: '100' } },
    flow: {
      nodes: [
        { id: 'swap1', type: 'cetus_swap', config: {} },
        { id: 'g1', type: 'guardrail', config: { minValue: '100' } },
      ],
      edges: [{ source: 'swap1', target: 'g1', sourceHandle: 'out', targetHandle: 'in' }],
    },
    nodeOutputs: { swap1: tx.gas },
    warnings: [],
    ...overrides,
  } as unknown as AdapterCtx;
}

test('an unwired guardrail is rejected, not ignored', async () => {
  const c = ctx({ flow: { nodes: [{ id: 'g1', type: 'guardrail', config: { minValue: '100' } }], edges: [] } as never });
  expect(guardrailAdapter.build(c)).rejects.toThrow(ValidationError);
});

test('a guardrail with no minimum configured is rejected, not silently skipped', async () => {
  const c = ctx({ node: { id: 'g1', type: 'guardrail', config: {} } as never });
  expect(guardrailAdapter.build(c)).rejects.toThrow(/no minimum value/i);
});

test('a guardrail with minValue 0 is rejected', async () => {
  const c = ctx({ node: { id: 'g1', type: 'guardrail', config: { minValue: '0' } } as never });
  expect(guardrailAdapter.build(c)).rejects.toThrow(/no minimum value/i);
});

test('a guardrail wired upstream of an action, with no coin to guard, is rejected', async () => {
  const c = ctx({ nodeOutputs: {} });
  expect(guardrailAdapter.build(c)).rejects.toThrow(/produces no coin to guard/i);
});

test('a correctly wired guardrail emits the on-chain assert', async () => {
  const c = ctx({});
  await guardrailAdapter.build(c);
  const targets = c.tx
    .getData()
    .commands.map((cmd) => (cmd as { MoveCall?: { module: string; function: string } }).MoveCall)
    .filter(Boolean)
    .map((m) => `${m!.module}::${m!.function}`);
  expect(targets).toContain('guard::assert_min_value');
});
