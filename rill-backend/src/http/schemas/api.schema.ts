import { z } from 'zod';
import { isHeroActionFlow } from '../../features/mcp/tool-schema';

export const IntrospectSchema = z.object({
  packageId: z.string().min(4, 'Invalid Sui Package ID'),
});

export const ResolveSchema = z.object({
  packageId: z.string().min(4, 'Invalid Sui Package ID'),
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

export const AgentWalletSchema = z.object({
  packageId: z.string().min(4),
  walletId: z.string().min(4),
  capId: z.string().min(4),
  coinType: z.string().optional(),
});

const FlowSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(FlowEdgeSchema),
});

export const CompileSchema = z.object({
  flow: FlowSchema,
  sender: z.string().optional(),
  agentWallet: AgentWalletSchema.optional(),
}).strict();

export const SimulateSchema = z.object({
  flow: FlowSchema,
  sender: z.string().optional(),
  agentWallet: AgentWalletSchema.optional(),
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
  sender: z.string().min(4),
  agentWallet: AgentWalletSchema,
}).strict();

export const SetupPrepareSchema = z.object({
  skillId: z.string().min(1),
  sender: z.string().min(4),
  budgetMist: z.string().regex(/^\d+$/, 'budgetMist must be a decimal u64 string.'),
  perTxMist: z.string().regex(/^\d+$/, 'perTxMist must be a decimal u64 string.'),
  minimumRemainingMist: z.string().regex(/^\d+$/, 'minimumRemainingMist must be a decimal u64 string.').optional(),
  expiresAtMs: z.string().regex(/^\d+$/, 'expiresAtMs must be a decimal u64 string.').optional(),
  clientOrderId: z.string().regex(/^\d+$/, 'clientOrderId must be a decimal u64 string.').optional(),
}).strict();
