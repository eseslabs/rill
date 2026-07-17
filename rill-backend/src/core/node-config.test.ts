import { afterEach, expect, test } from 'bun:test';
import { suiClient } from './config';
import { ValidationError } from './errors';
import { RUNTIME_KEYS, resolveCetusSwapConfig, resolveEffectiveFlow } from './node-config';
import { compilerService } from '../features/compiler/compiler.service';
import { previewService } from '../features/compiler/preview.service';

// The security boundary this file guards:
//
//   The AGENT declares INTENT — how much to swap.
//   The OWNER declares POLICY — how much slippage is tolerable.
//
// The floor is DERIVED from policy and live pool price. It is never chosen by the party it
// constrains. A floor an agent can set is a floor an agent can set to 1, and a protection the
// constrained party can switch off is not a protection.

const USDC = '0xaaa::usdc::USDC';
const SUI = '0x2::sui::SUI';
const POOL_TYPE = `0x5372::pool::Pool<${USDC}, ${SUI}>`;
const objectId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const realGetObject = suiClient.getObject.bind(suiClient);

afterEach(() => {
  suiClient.getObject = realGetObject as typeof suiClient.getObject;
});

/** Stub the on-chain pool read: a 1:1 pool (sqrt_price = 2^64) with a 0.25% fee. */
function stubPool() {
  suiClient.getObject = (async () => ({
    object: {
      type: POOL_TYPE,
      json: { current_sqrt_price: (1n << 64n).toString(), fee_rate: '2500', is_pause: false },
    },
  })) as unknown as typeof suiClient.getObject;
}

function swapNode(config: Record<string, unknown>) {
  return { id: 'swap-1', type: 'cetus_swap', config };
}

// --- The runtime allowlist: what a published MCP tool lets the agent choose.

test('the agent may declare how much to swap', () => {
  expect(RUNTIME_KEYS.cetus_swap).toContain('amount_in');
});

test('the agent may not choose its own slippage floor', () => {
  expect(RUNTIME_KEYS.cetus_swap).not.toContain('min_amount_out');
});

test('the agent may not widen its own slippage tolerance', () => {
  // Same hole wearing a different name: an agent that can set slippageBps to 9999 has set the
  // floor to ~0 without ever naming min_amount_out.
  expect(RUNTIME_KEYS.cetus_swap).not.toContain('slippageBps');
});

test('an agent-supplied min_amount_out is never honoured', () => {
  const flow = { nodes: [swapNode({ pool: '0xpool', inputCoinType: SUI, slippageBps: '100' })], edges: [] };

  expect(() => resolveEffectiveFlow(flow, { amount_in: '1000000', min_amount_out: '1' })).toThrow(
    ValidationError,
  );
});

test('an agent-supplied slippageBps is never honoured', () => {
  const flow = { nodes: [swapNode({ pool: '0xpool', inputCoinType: SUI, slippageBps: '100' })], edges: [] };

  expect(() => resolveEffectiveFlow(flow, { amount_in: '1000000', slippageBps: '9999' })).toThrow(
    ValidationError,
  );
});

test("the owner's own min_amount_out, published in the flow, still reaches config", () => {
  // The owner sets policy, so the owner-authored channels (config and the published `inputs`)
  // keep their floor. Only the runtime channel — the agent's — is closed.
  const viaConfig = resolveEffectiveFlow(
    { nodes: [swapNode({ min_amount_out: '987525' })], edges: [] },
    {},
  );
  expect(viaConfig.nodes[0].config?.min_amount_out).toBe('987525');

  const viaInputs = resolveEffectiveFlow(
    { nodes: [{ id: 'swap-1', type: 'cetus_swap', inputs: { min_amount_out: '987525' } }], edges: [] },
    {},
  );
  expect(viaInputs.nodes[0].config?.min_amount_out).toBe('987525');
});

// --- Fail closed: no floor is an error, never a permissive number.

test('a swap with no floor and no tolerance is rejected, not defaulted to 1 base unit', () => {
  expect(() => resolveCetusSwapConfig(swapNode({ amount_in: '1000000' }) as never)).toThrow(
    ValidationError,
  );
});

test('the rejection names what is missing', () => {
  expect(() => resolveCetusSwapConfig(swapNode({ amount_in: '1000000' }) as never)).toThrow(
    /slippageBps|min_amount_out/,
  );
});

test('an empty min_amount_out is treated as absent, not as zero', () => {
  expect(() =>
    resolveCetusSwapConfig(swapNode({ amount_in: '1000000', min_amount_out: '' }) as never),
  ).toThrow(ValidationError);
});

test('a zero min_amount_out is rejected — a floor of zero is no floor', () => {
  // injectMinOutAssert no-ops at minOut <= 0, so "0" would compile to a swap with no assert
  // at all. That is the `min_amount_out: "1"` bug one digit lower.
  expect(() =>
    resolveCetusSwapConfig(swapNode({ amount_in: '1000000', min_amount_out: '0' }) as never),
  ).toThrow(ValidationError);
});

test('a real floor resolves cleanly', () => {
  const { config } = resolveCetusSwapConfig(
    swapNode({ amount_in: '1000000', min_amount_out: '987525' }) as never,
  );
  expect(config.min_amount_out).toBe('987525');
});

// --- End to end: what the agent's MCP call actually compiles to.

test('an agent run compiles to the floor derived from owner policy, not to 1', async () => {
  stubPool();
  const result = await compilerService.compileFlow(
    {
      nodes: [swapNode({ pool: objectId(1), inputCoinType: SUI, slippageBps: '100' })],
      edges: [],
    },
    { sender: objectId(2) },
    { amount_in: '1000000' },
  );

  // 1:1 pool, 0.25% fee => 997500 expected; 1% owner tolerance => 987525.
  const assertCall = result.manifest.find((c) => c.target.endsWith('::guard::assert_min_value'));
  expect(assertCall).toBeDefined();
  expect(assertCall!.u64Args).toContain('987525');
  expect(assertCall!.u64Args).not.toContain('1');
  expect(assertCall!.typeArguments).toEqual([USDC]);

  // What the owner actually reads before signing, rendered from the compiled bytes.
  const preview = previewService.buildPreview(result.resolvedFlow, result.manifest, result.warnings);
  expect(preview).toContain(`::guard::assert_min_value<${USDC}> amounts=[987525]`);
  expect(preview).not.toContain('amounts=[1]');
});

test('an agent that hands itself a floor of 1 gets its whole run rejected', async () => {
  stubPool();
  const flow = {
    nodes: [swapNode({ pool: objectId(1), inputCoinType: SUI, slippageBps: '100' })],
    edges: [],
  };

  await expect(
    compilerService.compileFlow(flow, { sender: objectId(2) }, { amount_in: '1000000', min_amount_out: '1' }),
  ).rejects.toThrow(ValidationError);
});
