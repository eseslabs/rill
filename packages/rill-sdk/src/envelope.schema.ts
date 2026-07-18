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

// ---- Step manifest (WS2 generic signer policy) -----------------------------------------------
// Each entry describes ONE node in a composed on-chain flow, in the shape the signer's per-adapter
// structural validator (packages/rill-signer/src/steps/*) independently re-derives from the actual
// PTB bytes — the backend's declared step never substitutes for that re-derivation, it is only what
// the owner pre-approved the plan to contain (see policy.ts's inspectGeneric, a later unit).
//
// `steps` on the envelope below is deliberately OPTIONAL (not `.min(1)` as an earlier draft of this
// schema had it): this file is shared SDK code imported by rill-backend (skill-runner, openapi,
// keyless-execution tests), which does not populate `steps` yet (that's WS1, a separate follow-up).
// Making it required here would cascade-break the backend suite for a schema addition that is purely
// additive to this plan's scope. The signer enforces `steps` presence in its OWN dispatch logic once
// it starts consuming them (a later task in this plan) — this schema unit only defines the shape.

export const STEP_NODE_TYPES = ['cetus_swap', 'haedal_stake', 'deepbook_limit_order'] as const;

const CetusSwapStepSchema = z.object({
  nodeType: z.literal('cetus_swap'),
  poolId: nonEmptyString,
  /** The on-chain slippage floor asserted by rill_guard on the swap output. */
  minOutMist: nonEmptyString,
  spendAmountMist: nonEmptyString,
}).strict();

const HaedalStakeStepSchema = z.object({
  nodeType: z.literal('haedal_stake'),
  validator: nonEmptyString,
  spendAmountMist: nonEmptyString,
}).strict();

const DeepBookOrderStepSchema = z.object({
  nodeType: z.literal('deepbook_limit_order'),
  poolId: nonEmptyString,
  balanceManagerId: nonEmptyString,
  tradeCapId: nonEmptyString,
  spendAmountMist: nonEmptyString,
  order: z.object({
    clientOrderId: nonEmptyString,
    orderType: nonEmptyString,
    selfMatchingOption: nonEmptyString,
    price: nonEmptyString,
    quantity: nonEmptyString,
    isBid: z.boolean(),
    payWithDeep: z.boolean(),
    expiration: nonEmptyString,
  }).strict(),
}).strict();

export const StepSchema = z.discriminatedUnion('nodeType', [
  CetusSwapStepSchema,
  HaedalStakeStepSchema,
  DeepBookOrderStepSchema,
]);
export type EnvelopeStep = z.infer<typeof StepSchema>;

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
  /** Optional owner-approved step manifest — see the block above. Absent for every envelope the
   * backend emits today (DeepBook-only); populated once WS1 lands generic multi-step flows. */
  steps: z.array(StepSchema).min(1).optional(),
}).strict();

export type ExecutionEnvelope = z.infer<typeof ExecutionEnvelopeSchema>;
export type DeepBookResolvedParams = z.infer<typeof DeepBookResolvedParamsSchema>;
export type StrictSimulationResult = z.infer<typeof StrictSimulationResultSchema>;
