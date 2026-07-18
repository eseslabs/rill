import type {
  DeepBookResolvedParams,
  ExecutionEnvelope,
  StrictSimulationResult,
} from './envelope.schema';

// Re-exported so `ExecutionEnvelope` and friends keep resolving from `./types` for existing
// importers. The schema in `./envelope.schema` is the single canonical definition (KTD-4); these
// are `z.infer` types, not hand-written interfaces.
export type { DeepBookResolvedParams, ExecutionEnvelope, StrictSimulationResult };

export interface FlowEdge {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface FlowNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface AgentWalletBinding {
  packageId: string;
  walletId: string;
  capId: string;
  coinType?: string;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: string;
  type?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface IntrospectFunction {
  moduleName: string;
  functionName: string;
  parameters: unknown[];
  returnTypes: unknown[];
}

export interface ResolvedManifest {
  packageId: string;
  module: string;
  functionName: string;
  parameters: unknown[];
  [key: string]: unknown;
}

export type RillNetwork = 'testnet' | 'mainnet';

export type SimulationResult = StrictSimulationResult;

export interface JsonSchema {
  type: string;
  description?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export type ActionToolName = 'list_actions' | 'describe_action' | 'build_action';

export interface ActionToolDefinition {
  name: ActionToolName;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolDef {
  name: 'build_action';
  description: string;
  inputSchema: JsonSchema;
}

export interface PublishedSkill {
  id: string;
  name: string;
  description: string;
  mcpUrl: string;
  skillUrl: string;
  toolDefs: ToolDef;
  createdAt: string;
}

export interface PublishResult {
  skillId: string;
  name: string;
  description: string;
  mcpUrl: string;
  skillUrl: string;
  toolDefs: ToolDef;
  warnings: string[];
}

export type SkillRunResult = ExecutionEnvelope;

export interface HealthInfo {
  name: string;
  status: string;
  version: string;
  network?: string;
  apiBase?: string;
  walrus?: {
    readEndpoint: string;
    availability: 'unchecked';
    uploadsEnabled: false;
  };
}

export interface McpToolCallResult {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}
