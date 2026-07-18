import { z } from 'zod';
import { createWalrusClient } from '../../core/walrus-client';
import {
  EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES,
  EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS,
} from '../../../../packages/rill-sdk/src/execution-envelope';

/**
 * Zod-first (R15, mirrors KTD-2/R21's `ExecutionEnvelopeSchema` pattern): the audit record's shape
 * is declared once here and `AuditRecord` is derived from it, so a corrupted/tampered/malformed
 * Walrus blob fails a real structural check instead of being trusted as `as AuditRecord` and handed
 * to the client verbatim. Field-name/enum constants are re-used from `@rill/sdk`'s
 * `ExecutionEnvelopeSchema` where the shapes overlap (`simulation`) to avoid two independently
 * drifting definitions of "what a StrictSimulationResult looks like".
 */
const FlowNodeRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

const FlowEdgeRecordSchema = z.object({
  source: z.string(),
  sourceHandle: z.string(),
  target: z.string(),
  targetHandle: z.string(),
});

const FlowGraphRecordSchema = z.object({
  nodes: z.array(FlowNodeRecordSchema),
  edges: z.array(FlowEdgeRecordSchema),
});

const SimulationRecordSchema = z.object({
  ok: z.boolean(),
  verification: z.enum([...EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS]),
  error: z.string().optional(),
  gasEstimate: z.number(),
  balanceChanges: z.array(z.object({
    owner: z.string(),
    coinType: z.string(),
    amount: z.string(),
  })),
  objectChanges: z.array(z.object({
    type: z.enum([...EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES]),
    objectId: z.string(),
    objectType: z.string(),
  })),
});

export const AuditRecordSchema = z.object({
  version: z.literal('1'),
  service: z.literal('rill'),
  network: z.string().min(1),
  timestamp: z.string().min(1),
  flow: FlowGraphRecordSchema,
  params: z.record(z.string(), z.unknown()).optional(),
  simulation: SimulationRecordSchema,
  executed: z.boolean(),
  digest: z.string().optional(),
  warnings: z.array(z.string()),
});

export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/** Audit records are small generated JSON documents — this caps what `readAuditTrail` will decode
 *  and parse, so a corrupted or maliciously oversized blob can't turn one `/audit/:blobId` request
 *  into a pathological JSON.parse/decode over an unbounded byte string (R15). The Walrus SDK's
 *  `readBlob` has no partial-read API, so the whole blob is still fetched off-chain either way —
 *  this cap bounds what happens to it AFTER the read, not the read itself. */
const MAX_AUDIT_BLOB_BYTES = 256 * 1024;

export class WalrusAuditService {
  async readAuditTrail(blobId: string): Promise<AuditRecord> {
    const client = createWalrusClient();
    const bytes = await client.walrus.readBlob({ blobId });

    if (bytes.byteLength > MAX_AUDIT_BLOB_BYTES) {
      throw new Error(
        `Audit blob ${blobId} is ${bytes.byteLength} bytes, over the ${MAX_AUDIT_BLOB_BYTES}-byte cap.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(`Audit blob ${blobId} is not valid JSON.`);
    }

    const result = AuditRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Audit blob ${blobId} does not match the AuditRecord schema: ${result.error.message}`);
    }

    return result.data;
  }
}

export const walrusAuditService = new WalrusAuditService();
