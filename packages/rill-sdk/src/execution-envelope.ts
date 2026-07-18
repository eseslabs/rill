import type { z } from 'zod';
import { ExecutionEnvelopeSchema, type ExecutionEnvelope } from './envelope.schema';

// Field-name constants re-exported for backward compatibility — `rill-backend/src/http/openapi.ts`
// imports these from this module path to build its OpenAPI JSON-schema document. The schema itself
// (the actual single source of truth for ExecutionEnvelope's shape, per KTD-4) now lives in
// `./envelope.schema`; this file only re-exports the constants so existing import paths keep working.
export {
  EXECUTION_ENVELOPE_NETWORKS,
  EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES,
  EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS,
  EXECUTION_ENVELOPE_REQUIRED_FIELDS,
  EXECUTION_ENVELOPE_REQUIRED_STRING_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_BOOLEAN_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_NUMBER_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_REQUIRED_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_STRING_FIELDS,
  EXECUTION_ENVELOPE_SIMULATION_REQUIRED_FIELDS,
  EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS,
  EXECUTION_ENVELOPE_VERSION,
} from './envelope.schema';

function formatZodError(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  return `ExecutionEnvelope is invalid: ${details}`;
}

/**
 * Validate and narrow an unknown value to `ExecutionEnvelope`. Thin wrapper over
 * `ExecutionEnvelopeSchema` (see `./envelope.schema` for the canonical shape definition) — throws a
 * plain `Error` (matching prior behavior) whose message lists every failing field by path, so
 * existing substring-matching callers (e.g. `.rejects.toThrow('walletPackageId')`) keep working.
 */
export function assertExecutionEnvelope(value: unknown): ExecutionEnvelope {
  const result = ExecutionEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  return result.data;
}

export async function digestUnsignedPtb(unsignedPtb: string): Promise<string> {
  const bytes = new TextEncoder().encode(unsignedPtb);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
