import { expect, mock, test } from 'bun:test';

// Must be registered before `./audit.service` (and anything that transitively imports
// `core/walrus-client`) is imported below — Bun's `mock.module` retroactively overrides the module
// registry entry even for already-linked importers, since `createWalrusClient()` is called lazily
// inside `readAuditTrail`, not cached at module load (verified against Bun 1.3.9's actual behavior,
// not assumed).
let nextBlob: Uint8Array = new TextEncoder().encode('{}');

mock.module('../../core/walrus-client', () => ({
  createWalrusClient: () => ({
    walrus: {
      readBlob: async (_args: { blobId: string }) => nextBlob,
    },
  }),
}));

import { apiRouter } from '../../http/routes/api.routes';
import { AuditRecordSchema, walrusAuditService } from './audit.service';

function setBlob(value: string | Uint8Array) {
  nextBlob = typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

const validRecord = {
  version: '1' as const,
  service: 'rill' as const,
  network: 'testnet',
  timestamp: '2026-07-16T00:00:00.000Z',
  flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] },
  simulation: {
    ok: true,
    verification: 'verified' as const,
    gasEstimate: 7,
    balanceChanges: [],
    objectChanges: [],
  },
  executed: false,
  warnings: [],
};

test('AuditRecordSchema accepts a well-formed record', () => {
  expect(AuditRecordSchema.safeParse(validRecord).success).toBe(true);
});

test('AuditRecordSchema rejects an obviously wrong shape', () => {
  expect(AuditRecordSchema.safeParse({ hello: 'world' }).success).toBe(false);
});

test('readAuditTrail reads and validates a well-formed blob', async () => {
  setBlob(JSON.stringify(validRecord));
  const record = await walrusAuditService.readAuditTrail('blob_ok');
  expect(record).toEqual(validRecord);
});

test('readAuditTrail rejects a blob that is not valid JSON', async () => {
  setBlob('not json{{{');
  await expect(walrusAuditService.readAuditTrail('blob_bad_json')).rejects.toThrow();
});

test('readAuditTrail rejects a blob whose parsed JSON does not match AuditRecordSchema', async () => {
  setBlob(JSON.stringify({ hello: 'world' }));
  await expect(walrusAuditService.readAuditTrail('blob_wrong_shape')).rejects.toThrow();
});

test('readAuditTrail rejects an oversized blob without returning its content', async () => {
  setBlob('x'.repeat(1024 * 1024)); // 1 MiB — over the 256 KiB cap
  await expect(walrusAuditService.readAuditTrail('blob_huge')).rejects.toThrow();
});

test('GET /audit/:blobId sanitizes every failure mode to the same generic 404 (R15)', async () => {
  const cases = ['not json{{{', JSON.stringify({ hello: 'world' }), 'x'.repeat(1024 * 1024)];

  for (const [i, blob] of cases.entries()) {
    setBlob(blob);
    const response = await apiRouter.request(`/audit/blob_bad_${i}`);
    const body = await response.json() as { success: boolean; error: string };

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Audit record not found or unreadable.');
    // No raw error text (blob id, byte counts, JSON parse position, Zod issue paths) leaks out.
    expect(body.error).not.toContain('blob_bad');
    expect(body.error).not.toContain('JSON');
    expect(body.error).not.toContain('byte');
    expect(body.error.length).toBeLessThan(60);
  }
});

test('GET /audit/:blobId returns the parsed record on success', async () => {
  setBlob(JSON.stringify(validRecord));
  const response = await apiRouter.request('/audit/blob_ok');
  const body = await response.json() as { success: boolean; data: unknown };

  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  expect(body.data).toEqual(validRecord);
});
