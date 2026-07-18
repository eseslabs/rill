const API_FALLBACK = "https://api.rill.naisu.one/api";

function normalizeApiBase(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_RILL_API_URL;
  if (fromEnv) return normalizeApiBase(fromEnv);
  return API_FALLBACK;
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

const REQUEST_TIMEOUT_MS = 20_000;

/** Every request gets a hard timeout so a hung backend can never leave a
 *  dialog spinning forever (R18); an optional caller-supplied signal (e.g.
 *  from useFlowRequest's per-call AbortController) is composed in via
 *  `AbortSignal.any` so unmount/re-run abort still works alongside it. */
function composeSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: composeSignal(signal),
  });
  const json = await parseJsonResponse<{ success: boolean; data?: T; error?: string }>(res);
  if (!res.ok || !json.success || !json.data) {
    throw new Error(json.error ?? `API error ${res.status}`);
  }
  return json.data;
}

export const rillApi = {
  baseUrl: API_BASE,

  async health(signal?: AbortSignal) {
    const root = API_BASE.replace(/\/api$/, "");
    const res = await fetch(`${root}/health`, { signal: composeSignal(signal) });
    return parseJsonResponse<Record<string, unknown>>(res);
  },

  async protocols(signal?: AbortSignal) {
    const res = await fetch(`${API_BASE}/protocols`, { signal: composeSignal(signal) });
    const json = await parseJsonResponse<{ success: boolean; data?: ProtocolRegistry; error?: string }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? `API error ${res.status}`);
    }
    return json.data;
  },

  introspect(packageId: string, signal?: AbortSignal) {
    return post<BackendFunction[]>("/introspect", { packageId }, signal);
  },

  simulate(flow: FlowGraph, signal?: AbortSignal) {
    return post<{
      unsignedPtb: string;
      preview: string;
      simulation: SimulationResult;
      warnings: string[];
    }>("/simulate", { flow }, signal);
  },

  publish(flow: FlowGraph, signal?: AbortSignal) {
    return post<PublishResult>("/publish", { flow }, signal);
  },
};
