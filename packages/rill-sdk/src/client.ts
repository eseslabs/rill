import { RillApiError } from './errors';
import type {
  ActionToolDefinition,
  AgentWalletBinding,
  ApiResponse,
  FlowGraph,
  HealthInfo,
  IntrospectFunction,
  McpToolCallResult,
  PublishResult,
  PublishedSkill,
  ResolvedManifest,
  SimulationResult,
  SkillRunResult,
} from './types';

type BuildOptions = {
  sender?: string;
  agentWallet?: AgentWalletBinding;
};

function toolRejection(result: McpToolCallResult): { message: string; type: string } {
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const rejection = structured as Record<string, unknown>;
    if (typeof rejection.message === 'string') {
      return {
        message: rejection.message,
        type: typeof rejection.code === 'string' ? rejection.code : 'McpToolError',
      };
    }
  }

  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (text) {
    try {
      const rejection = JSON.parse(text) as unknown;
      if (rejection && typeof rejection === 'object' && !Array.isArray(rejection)) {
        const record = rejection as Record<string, unknown>;
        if (typeof record.message === 'string') {
          return {
            message: record.message,
            type: typeof record.code === 'string' ? record.code : 'McpToolError',
          };
        }
      }
    } catch {
      return { message: text, type: 'McpToolError' };
    }
    return { message: text, type: 'McpToolError' };
  }

  return { message: 'MCP tool rejected the request', type: 'McpToolError' };
}

export type RillClientOptions = {
  /** e.g. http://localhost:3002/api */
  baseUrl: string;
  fetch?: typeof fetch;
};

export type CallSkillInput = {
  sender: string;
  agentWallet: AgentWalletBinding;
  params: Record<string, unknown>;
};

export type BuildActionInput = CallSkillInput & { skillId: string };

export class RillClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: RillClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
  }

  async health(): Promise<HealthInfo> {
    const root = this.baseUrl.replace(/\/api$/, '');
    const res = await this.fetchFn(root);
    return res.json() as Promise<HealthInfo>;
  }

  introspect(packageId: string): Promise<IntrospectFunction[]> {
    return this.post('/introspect', { packageId });
  }

  resolve(packageId: string, moduleName: string, functionName: string): Promise<ResolvedManifest> {
    return this.post('/resolve', { packageId, moduleName, functionName });
  }

  compile(flow: FlowGraph, options: BuildOptions = {}): Promise<{
    unsignedPtb: string;
    preview: string;
    warnings: string[];
    agentWalletBound: boolean;
    budgetSpendMist: string;
  }> {
    return this.post('/compile', { flow, ...options });
  }

  simulate(flow: FlowGraph, options: BuildOptions = {}): Promise<{
    unsignedPtb: string;
    preview: string;
    simulation: SimulationResult;
    warnings: string[];
    agentWalletBound: boolean;
  }> {
    return this.post('/simulate', { flow, ...options });
  }

  publish(flow: FlowGraph, policyId?: string): Promise<PublishResult> {
    return this.post('/publish', { flow, policyId });
  }

  listSkills(): Promise<PublishedSkill[]> {
    return this.get('/skills');
  }

  buildAction(options: BuildActionInput): Promise<SkillRunResult> {
    return this.post('/execute', options);
  }

  /** MCP JSON-RPC tools/call */
  async callSkill(
    skillId: string,
    input: CallSkillInput,
    requestId: number | string = 1,
  ): Promise<SkillRunResult> {
    const result = await this.postJsonRpc<McpToolCallResult>(`/mcp/${skillId}`, {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: 'build_action',
        arguments: {
          actionId: skillId,
          sender: input.sender,
          agentWallet: input.agentWallet,
          params: input.params,
        },
      },
    });

    if (result.isError) {
      const rejection = toolRejection(result);
      throw new RillApiError(rejection.message, 400, rejection.type);
    }

    const text = result.content?.[0]?.text;
    if (!text) {
      throw new RillApiError('Empty MCP response', 500);
    }

    return JSON.parse(text) as SkillRunResult;
  }

  /** MCP JSON-RPC tools/list */
  listTools(skillId: string, requestId: number | string = 1) {
    return this.postJsonRpc<{ tools: ActionToolDefinition[] }>(`/mcp/${skillId}`, {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/list',
    });
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    return this.parseResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  private async postJsonRpc<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as { result?: T; error?: { message: string; code: number } };

    if (json.error) {
      throw new RillApiError(json.error.message, res.status, 'McpError');
    }

    if (!json.result) {
      throw new RillApiError('Missing MCP result', res.status);
    }

    return json.result;
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const json = (await res.json()) as ApiResponse<T>;

    if (!res.ok || !json.success) {
      const err = json as { error?: string; type?: string };
      throw new RillApiError(err.error ?? `HTTP ${res.status}`, res.status, err.type);
    }

    return json.data;
  }
}
