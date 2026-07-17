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

export interface StrictSimulationResult {
  ok: boolean;
  /**
   * 'verified'   — devInspect ran and the transaction succeeded.
   * 'unverified' — a known devInspect false negative (Cetus checked_package_version on testnet);
   *                the transaction is expected to succeed on-chain but we did not prove it.
   * 'failed'     — devInspect ran and the transaction aborted, or simulation could not run at all.
   * Consumers must treat anything other than 'verified' as fail-closed.
   */
  verification: 'verified' | 'unverified' | 'failed';
  error?: string;
  gasEstimate: number;
  balanceChanges: {
    owner: string;
    coinType: string;
    amount: string;
  }[];
  objectChanges: {
    type: 'mutated' | 'created' | 'deleted';
    objectId: string;
    objectType: string;
  }[];
}

export type SimulationResult = StrictSimulationResult;

export interface DeepBookResolvedParams {
  poolKey: string;
  poolId: string;
  price: number;
  quantity: number;
  isBid: boolean;
  payWithDeep: boolean;
  clientOrderId: string;
  depositSui: number;
  spendAmountMist: string;
}

export interface ExecutionEnvelope {
  version: '1';
  actionId: string;
  actionDigest: string;
  network: RillNetwork;
  sender: string;
  walletPackageId: string;
  walletId: string;
  agentCapId: string;
  balanceManagerId?: string;
  tradeCapId?: string;
  resolvedParams: DeepBookResolvedParams | Record<string, unknown>;
  allowedTargets: string[];
  requiredObjectIds: string[];
  requiredGuards: string[];
  unsignedPtb: string;
  preview: string;
  simulation: StrictSimulationResult;
  expiresAt: string;
}

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
