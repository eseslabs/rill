import { z } from 'zod';
import { isHeroActionFlow } from '../../features/mcp/tool-schema';
import { findFlowStructureIssues } from '../../features/protocols/handles';
import { CapabilityManifestSchema } from '../../../../packages/rill-sdk/src/capability-manifest';

/**
 * A Sui address/object id: `0x` + 1-64 hex chars (U4, R13). Sui accepts both the short form (e.g.
 * `0x2` for the Framework package) and the normalized 32-byte form (64 hex chars), so this matches
 * any length in between rather than forcing exactly 64 — the same range `@mysten/sui` itself treats
 * as a valid (if non-normalized) address. Garbage input (`"zz"`, no `0x` prefix, non-hex
 * characters, empty) fails Zod validation up front with a 422 instead of reaching a raw RPC call or
 * PTB argument and surfacing as an opaque downstream failure.
 */
const SUI_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,64}$/;

/** Builds a Sui-address-shaped Zod string schema; `label` is echoed into the error message so a
 *  422 names exactly which field was malformed. */
function suiAddress(label: string) {
  return z
    .string()
    .regex(SUI_ADDRESS_PATTERN, `${label} must be a 0x-prefixed hex Sui address (e.g. "0x2" or a 64-char object id).`);
}

export const IntrospectSchema = z.object({
  packageId: suiAddress('packageId'),
});

export const ResolveSchema = z.object({
  packageId: suiAddress('packageId'),
  moduleName: z.string().min(1, 'Module name is required'),
  functionName: z.string().min(1, 'Function name is required'),
});

export const FlowEdgeSchema = z.object({
  source: z.string(),
  sourceHandle: z.string(),
  target: z.string(),
  targetHandle: z.string(),
});

export const FlowNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.any()).optional(),
  inputs: z.record(z.string(), z.any()).optional(),
});

/**
 * `capabilityManifest` + `versionId` bind against the ONE (redesigned) Rule + Hot Potato
 * agent_wallet package (see `core/agent-wallet.ts`'s `normalizeAgentWallet`, the single place that
 * resolves a binding's package/version and enforces both fields are actually present). Both fields
 * are typed optional here at the Zod layer so a malformed/missing manifest still gets a clean 422
 * from `normalizeAgentWallet` (rather than this schema silently requiring one field but not the
 * other); `capabilityManifest`, when present, is validated via the SDK's `CapabilityManifestSchema`
 * — the same single source of truth `/capabilities/preview` and the compiler's own defense-in-depth
 * re-validation (`parseManifestOrThrow`) use — so a malformed manifest is rejected with a 422 here,
 * before it ever reaches `normalizeAgentWallet` or the compiler. There is no legacy manifest-less
 * `spend()` fallback: a request that binds an agent wallet without a `capabilityManifest` is
 * rejected by `normalizeAgentWallet`.
 */
export const AgentWalletSchema = z.object({
  packageId: suiAddress('agentWallet.packageId'),
  walletId: suiAddress('agentWallet.walletId'),
  capId: suiAddress('agentWallet.capId'),
  coinType: z.string().optional(),
  capabilityManifest: CapabilityManifestSchema.optional(),
  versionId: suiAddress('agentWallet.versionId').optional(),
});

/**
 * Structural flow validation (U3, KTD-3/R13): unique node ids, every edge referencing an existing
 * node, and every edge using a handle name registered for its endpoint's node type (the shared
 * `NODE_HANDLES` registry in `features/protocols/handles.ts`, next to the adapters that actually
 * consume those handles). `compiler.service.ts` runs the SAME check (`findFlowStructureIssues`)
 * again at the top of `compileFlow`, throwing a 422 `ValidationError` — that is what gives direct
 * callers (the MCP skill-runner bypasses this HTTP schema layer entirely) the same protection this
 * refinement gives `/compile` and `/simulate` requests.
 */
export const FlowSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(FlowEdgeSchema),
}).superRefine((flow, ctx) => {
  for (const issue of findFlowStructureIssues(flow)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path });
  }
});

/** R13: opts an anonymous request into binding the operator's configured server wallet
 *  (`config.agentWallet`) — see `api.routes.ts`'s `resolveAgentWallet`. Without this flag (and
 *  without an explicit `agentWallet`), /compile and /simulate never bind any wallet. */
const useServerWallet = z.boolean().optional();

export const CompileSchema = z.object({
  flow: FlowSchema,
  sender: suiAddress('sender').optional(),
  agentWallet: AgentWalletSchema.optional(),
  useServerWallet,
}).strict();

export const SimulateSchema = z.object({
  flow: FlowSchema,
  sender: suiAddress('sender').optional(),
  agentWallet: AgentWalletSchema.optional(),
  useServerWallet,
}).strict();

export const PublishSchema = z.object({
  flow: FlowSchema,
  policyId: z.string().optional(),
}).strict().refine(
  ({ flow }) => isHeroActionFlow(flow),
  {
    message: 'Publish supports exactly one deepbook_limit_order node with no edges.',
    path: ['flow'],
  },
);

export const ExecuteSchema = z.object({
  skillId: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  sender: suiAddress('sender'),
  agentWallet: AgentWalletSchema,
}).strict();

/**
 * U7/R11: wraps the SDK's `CapabilityManifestSchema` (already the single source of truth for
 * manifest validity, incl. the KTD-6 "no restrictions = unsafe" empty-rules refinement and the
 * duplicate-rule-kind check) in the request-body envelope `/capabilities/preview` expects. No
 * additional field-level validation is layered on here — the manifest's addresses/u64 amounts are
 * already validated by the SDK schema itself, so re-validating them here would just be a second,
 * possibly-drifting implementation of the same checks.
 */
export const CapabilityPreviewSchema = z.object({
  manifest: CapabilityManifestSchema,
}).strict();

export const SetupPrepareSchema = z.object({
  skillId: z.string().min(1),
  sender: suiAddress('sender'),
  budgetMist: z.string().regex(/^\d+$/, 'budgetMist must be a decimal u64 string.'),
  perTxMist: z.string().regex(/^\d+$/, 'perTxMist must be a decimal u64 string.'),
  minimumRemainingMist: z.string().regex(/^\d+$/, 'minimumRemainingMist must be a decimal u64 string.').optional(),
  expiresAtMs: z.string().regex(/^\d+$/, 'expiresAtMs must be a decimal u64 string.').optional(),
  clientOrderId: z.string().regex(/^\d+$/, 'clientOrderId must be a decimal u64 string.').optional(),
}).strict();
