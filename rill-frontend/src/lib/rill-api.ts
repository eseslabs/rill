const API_BASE =
  import.meta.env.VITE_RILL_API_URL?.replace(/\/$/, "") ??
  "https://api.rill.rifuki.dev/api";

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
  error?: string;
  gasEstimate: number;
  simulatedViaFallback?: boolean;
  balanceChanges?: unknown[];
  objectChanges?: unknown[];
};

export type ExecuteResult = {
  unsignedPtb: string;
  preview: string;
  simulation: SimulationResult;
  executed: boolean;
  digest?: string;
  warnings: string[];
  agentWalletBound: boolean;
  signable: boolean;
  devSignAvailable: boolean;
  walrus?: { blobId: string; explorerUrl: string };
};

export type PublishResult = {
  skillId: string;
  mcpUrl: string;
  toolDefs: { name: string; description: string };
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; data?: T; error?: string };
  if (!res.ok || !json.success || !json.data) {
    throw new Error(json.error ?? `API error ${res.status}`);
  }
  return json.data;
}

export const rillApi = {
  baseUrl: API_BASE,

  health() {
    const root = API_BASE.replace(/\/api$/, "");
    return fetch(root).then((r) => r.json());
  },

  protocols() {
    return fetch(`${API_BASE}/protocols`).then(async (r) => {
      const json = (await r.json()) as { success: boolean; data?: ProtocolRegistry; error?: string };
      if (!r.ok || !json.success || !json.data) {
        throw new Error(json.error ?? `API error ${r.status}`);
      }
      return json.data;
    });
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

  execute(flow: FlowGraph, execute = false, sender?: string) {
    return post<ExecuteResult>("/execute", { flow, execute, ...(sender ? { sender } : {}) });
  },

  publish(flow: FlowGraph) {
    return post<PublishResult>("/publish", { flow });
  },
};
