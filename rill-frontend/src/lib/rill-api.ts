function normalizeApiBase(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_RILL_API_URL;
  if (fromEnv) return normalizeApiBase(fromEnv);
  // Same-origin fallback keeps deploys portable; set VITE_RILL_API_URL for a remote backend.
  return "/api";
}

const API_BASE = resolveApiBase();

export type FlowEdge = {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
};

export type FlowNode = {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type SimulationResult = {
  ok: boolean;
  verification: "verified" | "unverified";
  error?: string;
  gasEstimate: number;
  balanceChanges?: unknown[];
  objectChanges?: unknown[];
};

export type PublishResult = {
  skillId: string;
  name: string;
  description: string;
  mcpUrl: string;
  skillUrl?: string;
  toolDefs: {
    name: "build_action";
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
  warnings: string[];
};

export type ProtocolRegistry = {
  network: string;
  cetus_swap: {
    integratePackageId: string;
    globalConfigId: string;
    defaultPoolId: string;
    defaultInputCoinType: string;
    tokens: { symbol: string; coinType: string }[];
    minSqrtPrice: string;
    maxSqrtPrice: string;
  };
  haedal_stake: {
    packageId: string;
    stakeTarget: string;
    suiSystemStateId: string;
    stakingObjectId: string;
    minStakeMist: string;
    coinType: string;
  };
};

export type BackendFunction = {
  packageId?: string;
  module: string;
  name: string;
  isEntry?: boolean;
  parameters: {
    index: number;
    name: string | null;
    moveType: string;
    class: string;
  }[];
};

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `API returned non-JSON (${res.status} from ${res.url}): ${text.slice(0, 120) || "(empty body)"}`,
    );
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await parseJsonResponse<{ success: boolean; data?: T; error?: string }>(res);
  if (!res.ok || !json.success || !json.data) {
    throw new Error(json.error ?? `API error ${res.status}`);
  }
  return json.data;
}

export const rillApi = {
  baseUrl: API_BASE,

  async health() {
    const root = API_BASE.replace(/\/api$/, "");
    const res = await fetch(`${root}/health`);
    return parseJsonResponse<Record<string, unknown>>(res);
  },

  async protocols() {
    const res = await fetch(`${API_BASE}/protocols`);
    const json = await parseJsonResponse<{ success: boolean; data?: ProtocolRegistry; error?: string }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? `API error ${res.status}`);
    }
    return json.data;
  },

  introspect(packageId: string) {
    return post<BackendFunction[]>("/introspect", { packageId });
  },

  simulate(flow: FlowGraph) {
    return post<{
      unsignedPtb: string;
      preview: string;
      simulation: SimulationResult;
      warnings: string[];
    }>("/simulate", { flow });
  },

  publish(flow: FlowGraph) {
    return post<PublishResult>("/publish", { flow });
  },
};
