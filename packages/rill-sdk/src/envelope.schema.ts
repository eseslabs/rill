import { z } from 'zod';

/**
 * The single definition of `ExecutionEnvelope` (KTD-4): this Zod schema is the ONE place the
 * envelope's shape is declared. `execution-envelope.ts`'s `assertExecutionEnvelope` is a thin
 * wrapper over `ExecutionEnvelopeSchema.safeParse`; `types.ts`'s `ExecutionEnvelope` type is
 * `z.infer` of this schema. The schema is strict at every object level (top level, `resolvedParams`,
 * `simulation`) — an envelope with any field beyond what is listed here fails validation. This is
 * deliberate: KTD-4 requires the envelope to gain no new field (e.g. no `simulationGate`), and a
 * strict schema turns "someone added a field" into a hard validation failure instead of a silent
 * pass-through.
 *
 * Field shape mirrors exactly what `rill-backend/src/features/mcp/skill-runner.service.ts` builds
 * and what the previous hand-written `assertExecutionEnvelope` validated — no new fields, no new
 * semantic checks (e.g. `expiresAt`/`actionDigest` stay plain non-empty strings here; format/digest
 * verification is `packages/rill-signer/src/policy.ts`'s job, unchanged by this unit).
 */

// ---- Field-name constants -----------------------------------------------------------------
// `rill-backend/src/http/openapi.ts` imports these to generate the OpenAPI JSON-schema document
// for the `/execute` response. Values are unchanged from the pre-existing hand-written validator.

export const EXECUTION_ENVELOPE_VERSION = '1' as const;
export const EXECUTION_ENVELOPE_NETWORKS = ['testnet', 'mainnet'] as const;
export const EXECUTION_ENVELOPE_REQUIRED_STRING_FIELDS = [
  'walletPackageId',
  'walletId',
  'agentCapId',
  'actionId',
  'actionDigest',
  'network',
  'sender',
  'balanceManagerId',
  'tradeCapId',
  'unsignedPtb',
  'preview',
  'expiresAt',
] as const;
export const EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS = [
  'allowedTargets',
  'requiredObjectIds',
  'requiredGuards',
] as const;
export const EXECUTION_ENVELOPE_REQUIRED_FIELDS = [
  'version',
  'actionId',
  'actionDigest',
  'network',
  'sender',
  'walletPackageId',
  'walletId',
  'agentCapId',
  'balanceManagerId',
  'tradeCapId',
  'resolvedParams',
  ...EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS,
  'unsignedPtb',
  'preview',
  'simulation',
  'expiresAt',
] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_STRING_FIELDS = [
  'poolKey',
  'poolId',
  'clientOrderId',
  'spendAmountMist',
] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_NUMBER_FIELDS = [
  'price',
  'quantity',
  'depositSui',
] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_BOOLEAN_FIELDS = ['isBid', 'payWithDeep'] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_REQUIRED_FIELDS = [
  ...EXECUTION_ENVELOPE_RESOLVED_PARAM_STRING_FIELDS,
  ...EXECUTION_ENVELOPE_RESOLVED_PARAM_NUMBER_FIELDS,
  ...EXECUTION_ENVELOPE_RESOLVED_PARAM_BOOLEAN_FIELDS,
] as const;
export const EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS = ['verified', 'unverified'] as const;
export const EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES = ['mutated', 'created', 'deleted'] as const;
export const EXECUTION_ENVELOPE_SIMULATION_REQUIRED_FIELDS = [
  'ok',
  'verification',
  'gasEstimate',
  'balanceChanges',
  'objectChanges',
] as const;

// ---- Schema ------------------------------------------------------------------------------

const nonEmptyString = z.string().min(1);

const BalanceChangeSchema = z.object({
  owner: z.string(),
  coinType: z.string(),
  amount: z.string(),
}).strict();

const ObjectChangeSchema = z.object({
  type: z.enum([...EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES]),
  objectId: z.string(),
  objectType: z.string(),
}).strict();

const StrictSimulationResultSchema = z.object({
  ok: z.boolean(),
  verification: z.enum([...EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS]),
  error: z.string().optional(),
  gasEstimate: z.number().finite(),
  balanceChanges: z.array(BalanceChangeSchema),
  objectChanges: z.array(ObjectChangeSchema),
}).strict();

const DeepBookResolvedParamsSchema = z.object({
  poolKey: nonEmptyString,
  poolId: nonEmptyString,
  price: z.number().finite(),
  quantity: z.number().finite(),
  isBid: z.boolean(),
  payWithDeep: z.boolean(),
  clientOrderId: nonEmptyString,
  depositSui: z.number().finite(),
  spendAmountMist: nonEmptyString,
}).strict();

export const ExecutionEnvelopeSchema = z.object({
  version: z.literal(EXECUTION_ENVELOPE_VERSION),
  actionId: nonEmptyString,
  actionDigest: nonEmptyString,
  network: z.enum([...EXECUTION_ENVELOPE_NETWORKS]),
  sender: nonEmptyString,
  walletPackageId: nonEmptyString,
  walletId: nonEmptyString,
  agentCapId: nonEmptyString,
  balanceManagerId: nonEmptyString,
  tradeCapId: nonEmptyString,
  resolvedParams: DeepBookResolvedParamsSchema,
  allowedTargets: z.array(z.string()),
  requiredObjectIds: z.array(z.string()),
  requiredGuards: z.array(z.string()),
  unsignedPtb: nonEmptyString,
  preview: nonEmptyString,
  simulation: StrictSimulationResultSchema,
  expiresAt: nonEmptyString,
}).strict();

export type ExecutionEnvelope = z.infer<typeof ExecutionEnvelopeSchema>;
export type DeepBookResolvedParams = z.infer<typeof DeepBookResolvedParamsSchema>;
export type StrictSimulationResult = z.infer<typeof StrictSimulationResultSchema>;
