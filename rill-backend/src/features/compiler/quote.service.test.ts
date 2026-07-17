import { afterEach, expect, test } from 'bun:test';
import { suiClient } from '../../core/config';
import { applyQuotedFloors, expectedOutFromSqrtPrice, applySlippage } from './quote.service';

// Q64.64: sqrt_price = 2^64 means a raw price ratio of exactly 1:1.
const ONE = 1n << 64n;

test('a 1:1 pool with no fee returns the input amount', () => {
  expect(expectedOutFromSqrtPrice(1_000_000n, ONE, true, 0n)).toBe(1_000_000n);
});

test('price is the square of sqrt_price — 2x sqrt_price is a 4x rate', () => {
  expect(expectedOutFromSqrtPrice(1_000_000n, ONE * 2n, true, 0n)).toBe(4_000_000n);
});

test('b2a inverts the rate', () => {
  expect(expectedOutFromSqrtPrice(4_000_000n, ONE * 2n, false, 0n)).toBe(1_000_000n);
});

test('the fee rate is charged in millionths', () => {
  // fee_rate 2500 = 0.25%
  expect(expectedOutFromSqrtPrice(1_000_000n, ONE, true, 2500n)).toBe(997_500n);
});

test('slippage is applied in basis points', () => {
  expect(applySlippage(1_000_000n, 100n)).toBe(990_000n); // 1.00%
});

test('a zero slippage floor equals the expected output', () => {
  expect(applySlippage(1_000_000n, 0n)).toBe(1_000_000n);
});

test('a slippage floor of 100% is rejected — that is no floor at all', () => {
  expect(() => applySlippage(1_000_000n, 10_000n)).toThrow(/slippage/i);
});

test('quotes are exact integers, never floats', () => {
  const out = expectedOutFromSqrtPrice(333_333_333n, ONE + 12345n, true, 3000n);
  expect(typeof out).toBe('bigint');
});

// --- applyQuotedFloors: the compile-time pre-pass that turns slippageBps into a real floor.
// The floor must be derived at compile time, not baked into the saved flow: a published skill is
// re-compiled on every agent run, and a floor frozen at publish time would assert a stale price.

const USDC = '0xaaa::usdc::USDC';
const SUI = '0x2::sui::SUI';
const POOL_TYPE = `0x5372::pool::Pool<${USDC}, ${SUI}>`;
const realGetObject = suiClient.getObject.bind(suiClient);

afterEach(() => {
  suiClient.getObject = realGetObject as typeof suiClient.getObject;
});

/** Stub the one on-chain read: a 1:1 pool (sqrt_price = 2^64) with a 0.25% fee. */
function stubPool(overrides: Record<string, unknown> = {}) {
  suiClient.getObject = (async () => ({
    object: {
      type: POOL_TYPE,
      json: { current_sqrt_price: ONE.toString(), fee_rate: '2500', is_pause: false, ...overrides },
    },
  })) as unknown as typeof suiClient.getObject;
}

function swapFlow(config: Record<string, unknown>) {
  return { nodes: [{ id: 'swap-1', type: 'cetus_swap', config }], edges: [] };
}

test('a swap that declares slippageBps compiles to a real floor, not 1 base unit', async () => {
  stubPool();
  const flow = swapFlow({ pool: '0xpool', inputCoinType: SUI, amount_in: '1000000', slippageBps: '100' });

  await applyQuotedFloors(flow, []);

  // 1:1 pool, 0.25% fee => 997500 expected; 1% slippage => 987525.
  expect(flow.nodes[0].config!.min_amount_out).toBe('987525');
});

test('an explicit min_amount_out is left alone — the caller already chose a floor', async () => {
  stubPool();
  const flow = swapFlow({
    pool: '0xpool',
    inputCoinType: SUI,
    amount_in: '1000000',
    slippageBps: '100',
    min_amount_out: '12345',
  });

  await applyQuotedFloors(flow, []);

  expect(flow.nodes[0].config!.min_amount_out).toBe('12345');
});

test('a swap declaring neither slippageBps nor min_amount_out is left for the config layer', async () => {
  stubPool();
  const flow = swapFlow({ pool: '0xpool', inputCoinType: SUI, amount_in: '1000000' });

  await applyQuotedFloors(flow, []);

  expect(flow.nodes[0].config!.min_amount_out).toBeUndefined();
});

test('a failed quote blocks the compile — it never falls back to a permissive floor', async () => {
  suiClient.getObject = (async () => {
    throw new Error('rpc unreachable');
  }) as unknown as typeof suiClient.getObject;
  const flow = swapFlow({ pool: '0xpool', inputCoinType: SUI, amount_in: '1000000', slippageBps: '100' });

  await expect(applyQuotedFloors(flow, [])).rejects.toThrow(/pool|quote|unreachable/i);
  expect(flow.nodes[0].config!.min_amount_out).toBeUndefined();
});

test('the direction follows the pool type args, so a b2a swap is not quoted as a2b', async () => {
  // Pool is Pool<USDC, SUI>; input SUI => b2a. A 2x sqrt_price pool has a 4x a2b rate, so b2a
  // must divide (250000), not multiply (4000000) — getting this backwards would floor a swap
  // 16x too high and revert every fill.
  stubPool({ current_sqrt_price: (ONE * 2n).toString(), fee_rate: '0' });
  const flow = swapFlow({ pool: '0xpool', inputCoinType: SUI, amount_in: '1000000', slippageBps: '0' });

  await applyQuotedFloors(flow, []);

  expect(flow.nodes[0].config!.min_amount_out).toBe('250000');
});
