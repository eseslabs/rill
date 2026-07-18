import { expect, test } from 'bun:test';
import { apiRouter } from './api.routes';
import { buildOpenApiDocument } from '../openapi';
import {
  toDeclaration,
  toOnChainRuleParams,
  toSignerPolicy,
  type CapabilityManifest,
} from '../../../../packages/rill-sdk/src/capability-manifest';

/**
 * U7/R11: `POST /api/capabilities/preview` — a read-only preview of a `CapabilityManifest`'s three
 * projections BEFORE the owner attaches it to a wallet. These tests cover: a valid manifest returns
 * all three projections matching the SDK's own projection functions exactly; an invalid (unknown
 * rule kind) manifest is rejected at 422; an empty-rules manifest is rejected at 422 with the SDK's
 * honest "no restrictions = unsafe" message (KTD-6); the handler never touches the network (proof
 * it's a pure projection, never a chain call); and the OpenAPI document describes the endpoint.
 */

const manifest: CapabilityManifest = {
  walletCoinType: '0x2::sui::SUI',
  rules: [
    { kind: 'budget', totalMist: '5000000000' },
    { kind: 'per_tx', maxMist: '1000000000' },
    { kind: 'rate_limit', windowMs: '3600000', maxMist: '2000000000' },
    { kind: 'protocol_scope', allowedPackages: [`0x${'a'.repeat(64)}`] },
    { kind: 'slippage_floor', minBps: 50 },
    { kind: 'asset_scope', allowedCoinTypes: ['0x2::sui::SUI'] },
    { kind: 'recipient_allowlist', addresses: [`0x${'b'.repeat(64)}`] },
    { kind: 'time_window', notBeforeMs: '1000', notAfterMs: '2000' },
  ],
};

/** Recursively converts `bigint` leaves to decimal strings — `toOnChainRuleParams` returns `bigint`
 *  for u64 config fields (the SDK's single money path), but the HTTP response (like every other u64
 *  amount that crosses HTTP in this codebase) carries them as decimal strings, since JSON has no
 *  `bigint` type. Used here to build the expected shape from the real SDK projection rather than
 *  hand-writing a second copy of it. */
function bigintToString(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(bigintToString);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintToString(v)]));
  }
  return value;
}

function previewRequest(body: unknown) {
  return apiRouter.request('/capabilities/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('valid manifest returns all three projections, matching the SDK functions exactly', async () => {
  const response = await previewRequest({ manifest });

  expect(response.status).toBe(200);
  const body = await response.json() as {
    success: boolean;
    data: { onChainRules: unknown; signerPolicy: unknown; declaration: unknown };
  };
  expect(body.success).toBe(true);
  expect(Object.keys(body.data).sort()).toEqual(['declaration', 'onChainRules', 'signerPolicy']);

  expect(body.data.onChainRules).toEqual(bigintToString(toOnChainRuleParams(manifest)));
  expect(body.data.signerPolicy).toEqual(toSignerPolicy(manifest));
  expect(body.data.declaration).toEqual(toDeclaration(manifest));
});

test('declaration matches toDeclaration output field-for-field (summaryLines + caps)', async () => {
  const response = await previewRequest({ manifest });
  const body = await response.json() as { data: { declaration: { summaryLines: string[]; caps: unknown[] } } };
  const expected = toDeclaration(manifest);

  expect(body.data.declaration.summaryLines).toEqual(expected.summaryLines);
  expect(body.data.declaration.caps).toEqual(expected.caps);
  expect(body.data.declaration.caps).toHaveLength(8);
});

test('onChainRules serializes u64 config fields as decimal strings, not numbers or raw bigint', async () => {
  const response = await previewRequest({ manifest });
  const body = await response.json() as {
    data: { onChainRules: Array<{ ruleWitness: string; module: string; config: Record<string, unknown> }> };
  };
  const budgetRule = body.data.onChainRules.find((r) => r.ruleWitness === 'BudgetRule');
  expect(budgetRule?.config.totalMist).toBe('5000000000');
  expect(typeof budgetRule?.config.totalMist).toBe('string');
});

test('an unknown rule kind is rejected with 422', async () => {
  const response = await previewRequest({
    manifest: {
      walletCoinType: '0x2::sui::SUI',
      rules: [{ kind: 'not_a_real_rule_kind', totalMist: '1' }],
    },
  });

  expect(response.status).toBe(422);
  const body = await response.json() as { success: boolean; type: string };
  expect(body.success).toBe(false);
  expect(body.type).toBe('ValidationError');
});

test('an empty-rules manifest is rejected with 422 and the SDK\'s honest "no restrictions" message', async () => {
  const response = await previewRequest({
    manifest: { walletCoinType: '0x2::sui::SUI', rules: [] },
  });

  expect(response.status).toBe(422);
  const body = await response.json() as { success: boolean; error: string };
  expect(body.success).toBe(false);
  expect(body.error).toContain('no restrictions');
  expect(body.error).toContain('unsafe');
  expect(body.error).toContain('rules must not be empty');
});

test('a manifest missing walletCoinType is rejected with 422 (schema-invalid, not a 500)', async () => {
  const response = await previewRequest({
    manifest: { rules: [{ kind: 'budget', totalMist: '1' }] },
  });

  expect(response.status).toBe(422);
});

test('a duplicate rule kind is rejected with 422', async () => {
  const response = await previewRequest({
    manifest: {
      walletCoinType: '0x2::sui::SUI',
      rules: [
        { kind: 'budget', totalMist: '1000' },
        { kind: 'budget', totalMist: '2000' },
      ],
    },
  });

  expect(response.status).toBe(422);
  const body = await response.json() as { error: string };
  expect(body.error).toContain('Duplicate rule kind');
});

test('a completely malformed body (not even an object) is rejected, never a 500', async () => {
  const response = await previewRequest({ manifest: 'not-an-object' });
  expect(response.status).toBe(422);
});

// --- Purity: the handler never touches the network -----------------------------------------

test('the handler never calls fetch — pure projection, no chain client, no signing', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalled = true;
    return originalFetch(...args);
  }) as typeof fetch;

  try {
    const response = await previewRequest({ manifest });
    expect(response.status).toBe(200);
    expect(fetchCalled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- OpenAPI contract -------------------------------------------------------------------------

test('OpenAPI documents /capabilities/preview request and response shape', () => {
  const document = buildOpenApiDocument('https://api.example.com') as unknown as {
    paths: Record<string, {
      post: {
        requestBody: { content: { 'application/json': { schema: { properties: Record<string, unknown> } } } };
        responses: Record<string, {
          content?: { 'application/json': { schema: { properties?: { data?: { properties?: Record<string, unknown> } } } } };
        }>;
      };
    }>;
  };
  const operation = document.paths['/capabilities/preview'].post;

  expect(Object.keys(operation.requestBody.content['application/json'].schema.properties)).toEqual(['manifest']);

  const dataSchema = operation.responses['200'].content?.['application/json'].schema.properties?.data;
  expect(Object.keys(dataSchema?.properties ?? {}).sort()).toEqual(['declaration', 'onChainRules', 'signerPolicy']);

  expect(operation.responses['422']).toBeDefined();
});
