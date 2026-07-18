import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  toDeclaration,
  toOnChainRuleParams,
  toSignerPolicy,
  type OnChainRuleConfigValue,
  type OnChainRuleParams,
} from '../../../../packages/rill-sdk/src/capability-manifest';
import { SUI_COIN_TYPE, type AgentWalletBinding } from '../../core/agent-wallet';
import { config } from '../../core/config';
import { getProtocolRegistry, DEFAULT_SIMULATE_SENDER } from '../../core/protocols';
import { introspectService } from '../../features/introspect/introspect.service';
import { resolverService } from '../../features/introspect/resolver.service';
import { compilerService } from '../../features/compiler/compiler.service';
import { previewService } from '../../features/compiler/preview.service';
import { serializeUnsignedPtb } from '../../features/compiler/ptb.util';
import { simulatorService } from '../../features/compiler/simulator.service';
import { skillsStore } from '../../features/mcp/skills.store';
import { skillRunnerService } from '../../features/mcp/skill-runner.service';
import {
  buildToolDefs,
  HERO_ACTION_DESCRIPTION,
  HERO_ACTION_NAME,
} from '../../features/mcp/tool-schema';
import { buildSkillDoc } from '../../features/mcp/skill-doc';
import { renderAgentInstructions } from '../../features/mcp/agent-instructions';
import { handleMcpJsonRpc } from '../../features/mcp/mcp.service';
import { prepareSetupPlan } from '../../features/setup/setup.service';
import { walrusAuditService } from '../../features/walrus/audit.service';
import {
  IntrospectSchema,
  ResolveSchema,
  CompileSchema,
  SimulateSchema,
  PublishSchema,
  ExecuteSchema,
  SetupPrepareSchema,
  CapabilityPreviewSchema,
} from '../schemas/api.schema';

export const apiRouter = new Hono();

/** Publish/compile/simulate flow-size cap (R13) — a pathological flow (hundreds of nodes) turns one
 *  request into unbounded compiler/adapter work (RPC calls, PTB commands); reject up front instead
 *  of discovering the cost mid-compile. */
const MAX_FLOW_NODES = 20;

function flowSizeCapError(nodeCount: number) {
  return {
    success: false as const,
    error: `Flow has ${nodeCount} nodes; Rill caps compiled/simulated/published flows at `
      + `${MAX_FLOW_NODES} nodes.`,
    type: 'FlowTooLarge',
  };
}

/** Stored-skill cap (R13) — configurable via env, defaults to a generous but finite number. At
 *  capacity, new publishes are REJECTED with an explicit error; existing skills are never evicted
 *  to make room (an agent that published a live MCP link must never have it silently disappear). */
const MAX_STORED_SKILLS = (() => {
  const parsed = Number.parseInt(process.env.MAX_STORED_SKILLS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
})();

function skillCapacityError() {
  return {
    success: false as const,
    error: `Rill has reached its published-skill capacity (${MAX_STORED_SKILLS}). No new skills `
      + `can be published until capacity is freed by an operator; existing skills are never evicted `
      + `automatically.`,
    type: 'SkillCapacityReached',
  };
}

/** Exact-match Origin allowlist for the MCP endpoint (R14) — a browser-originated cross-site
 *  request must come from an origin Rill actually serves, matched by exact parsed-hostname equality
 *  (localhost/127.0.0.1, any port) or full-origin string equality against `PUBLIC_BASE_URL` — never
 *  substring/prefix (a lookalike host like "notlocalhost.evil.com" must not slip through a naive
 *  `.includes('localhost')` check). Non-browser MCP clients (curl, Claude Code, OpenCode) typically
 *  send no `Origin` header at all, so validation only fires when the header is present.
 */
const MCP_ALLOWED_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isAllowedMcpOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (MCP_ALLOWED_ORIGIN_HOSTS.has(parsed.hostname)) return true;
  try {
    return parsed.origin === new URL(config.publicBaseUrl).origin;
  } catch {
    return false;
  }
}

function normalizeAgentWallet(
  agentWallet: Omit<AgentWalletBinding, 'coinType'> & { coinType?: string },
): AgentWalletBinding {
  return {
    packageId: agentWallet.packageId,
    walletId: agentWallet.walletId,
    capId: agentWallet.capId,
    coinType: agentWallet.coinType ?? SUI_COIN_TYPE,
  };
}

/**
 * R13: an anonymous /compile or /simulate request binds the operator's configured `config.agentWallet`
 * ONLY when the caller explicitly opts in with `useServerWallet: true` — never by default. Silently
 * defaulting every wallet-less request to the operator's real wallet meant any anonymous caller could
 * get a PTB that spends from it without ever asking; the honest behavior (KTD-1) is the no-wallet
 * warning branch unless the caller asks for the server wallet by name.
 */
function resolveAgentWallet(body: {
  agentWallet?: Omit<AgentWalletBinding, 'coinType'> & { coinType?: string };
  useServerWallet?: boolean;
}): AgentWalletBinding | undefined {
  if (body.agentWallet) return normalizeAgentWallet(body.agentWallet);
  return body.useServerWallet === true ? config.agentWallet : undefined;
}

apiRouter.get('/protocols', (c) => {
  return c.json({ success: true, data: getProtocolRegistry(config.network) });
});

/** `toOnChainRuleParams` returns `bigint` for u64 config fields (the SDK's single money path,
 *  never floating point) — `JSON.stringify`/`c.json` cannot serialize `bigint` directly, so this
 *  converts each rule's config values to their decimal-string wire form (the same convention used
 *  everywhere else a u64 amount crosses HTTP, e.g. `/compile`'s `budgetSpendMist`). Non-bigint
 *  values (strings, numbers, arrays) pass through unchanged. */
function serializeOnChainRuleParams(rules: OnChainRuleParams[]) {
  const serializeValue = (value: OnChainRuleConfigValue): string | number | readonly string[] | readonly number[] =>
    typeof value === 'bigint' ? value.toString() : value;

  return rules.map((rule) => ({
    module: rule.module,
    config: Object.fromEntries(
      Object.entries(rule.config).map(([key, value]) => [key, serializeValue(value)]),
    ),
  }));
}

/**
 * Task 5 (U7, R11): "see exactly what you're granting" before publishing. Takes a
 * `CapabilityManifest` and returns its three synchronized projections — the on-chain
 * `add_rule`/`prove` params U5's compiler would assemble into a PTB, the signer's flat pre-flight
 * policy shape, and the human/agent-readable declaration U3 renders into skill.md /
 * agent-instructions. Validation runs entirely through the SDK's own `CapabilityManifestSchema`
 * (via `CapabilityPreviewSchema`), so an empty-rules or unknown-kind manifest is rejected with a
 * 422 carrying the SDK's own honest "no restrictions = unsafe" message (KTD-6) — never a
 * fabricated 200.
 *
 * PURE projection, deliberately: the handler body below calls only the three SDK projection
 * functions on the already-validated request body. It imports no chain client, no signer, no
 * skills store — nothing here can sign a transaction, submit one, or touch the network. Read-only.
 */
apiRouter.post(
  '/capabilities/preview',
  zValidator('json', CapabilityPreviewSchema, (result, c) => {
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('; ');
      return c.json({ success: false, error: message, type: 'ValidationError' }, 422);
    }
  }),
  (c) => {
    const { manifest } = c.req.valid('json');
    return c.json({
      success: true,
      data: {
        onChainRules: serializeOnChainRuleParams(toOnChainRuleParams(manifest)),
        signerPolicy: toSignerPolicy(manifest),
        declaration: toDeclaration(manifest),
      },
    });
  },
);

apiRouter.post('/introspect', zValidator('json', IntrospectSchema), async (c) => {
  const { packageId } = c.req.valid('json');
  const functions = await introspectService.introspectPackage(packageId);
  return c.json({ success: true, data: functions });
});

apiRouter.post('/resolve', zValidator('json', ResolveSchema), async (c) => {
  const { packageId, moduleName, functionName } = c.req.valid('json');
  const manifest = await resolverService.resolveSemantics(packageId, moduleName, functionName);
  return c.json({ success: true, data: manifest });
});

apiRouter.post('/compile', zValidator('json', CompileSchema), async (c) => {
  const body = c.req.valid('json');
  if (body.flow.nodes.length > MAX_FLOW_NODES) {
    return c.json(flowSizeCapError(body.flow.nodes.length), 422);
  }
  const compileResult = await compilerService.compileFlow(body.flow, {
    sender: body.sender,
    agentWallet: resolveAgentWallet(body),
  });

  const preview = previewService.buildPreview(compileResult.resolvedFlow, compileResult.warnings);
  const unsignedPtb = await serializeUnsignedPtb(compileResult.transaction);

  return c.json({
    success: true,
    data: {
      unsignedPtb,
      preview,
      warnings: compileResult.warnings,
      agentWalletBound: compileResult.agentWalletBound,
      budgetSpendMist: compileResult.budgetSpendMist.toString(),
    },
  });
});

apiRouter.post('/simulate', zValidator('json', SimulateSchema), async (c) => {
  const body = c.req.valid('json');
  if (body.flow.nodes.length > MAX_FLOW_NODES) {
    return c.json(flowSizeCapError(body.flow.nodes.length), 422);
  }
  const compileResult = await compilerService.compileFlow(body.flow, {
    sender: body.sender ?? DEFAULT_SIMULATE_SENDER,
    agentWallet: resolveAgentWallet(body),
  });

  const simulation = await simulatorService.simulateTransaction(
    compileResult.transaction,
    body.sender,
  );
  const preview = previewService.buildPreview(compileResult.resolvedFlow, compileResult.warnings);
  const unsignedPtb = await serializeUnsignedPtb(compileResult.transaction);

  return c.json({
    success: true,
    data: {
      unsignedPtb,
      preview,
      simulation,
      warnings: compileResult.warnings,
      agentWalletBound: compileResult.agentWalletBound,
    },
  });
});

apiRouter.post('/publish', zValidator('json', PublishSchema), async (c) => {
  const { flow, policyId } = c.req.valid('json');

  if (flow.nodes.length > MAX_FLOW_NODES) {
    return c.json(flowSizeCapError(flow.nodes.length), 422);
  }
  if (skillsStore.list().length >= MAX_STORED_SKILLS) {
    return c.json(skillCapacityError(), 507);
  }

  const warnings = [
    'Published metadata only; build_action requires run-specific wallet, BalanceManager, TradeCap, sender, and runtime order params.',
  ];

  const skillId = `skill_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const toolDefs = buildToolDefs(flow, skillId);
  const mcpUrl = `${config.publicBaseUrl}/api/mcp/${skillId}`;
  const skillUrl = `${config.publicBaseUrl}/api/skills/${skillId}/skill.md`;

  skillsStore.save({
    id: skillId,
    name: HERO_ACTION_NAME,
    description: HERO_ACTION_DESCRIPTION,
    flow,
    toolDefs,
    policyId,
    createdAt: new Date().toISOString(),
  });

  return c.json({
    success: true,
    data: {
      skillId,
      name: HERO_ACTION_NAME,
      description: HERO_ACTION_DESCRIPTION,
      mcpUrl,
      skillUrl,
      toolDefs,
      warnings,
    },
  });
});

/** Skill doc — paste this URL into any AI agent (Claude Code, OpenClaw, Hermes, …). */
apiRouter.get('/skills/:id/skill.md', (c) => {
  const skill = skillsStore.get(c.req.param('id'));
  if (!skill) return c.text('Skill not found', 404);
  return c.text(buildSkillDoc(skill), 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

/** Ready-to-paste agent-instructions template (task 4 / R10) — the mcp-add commands, the correct
 *  tool sequence, and the active guardrails declared honestly. `PublishedSkill` does not carry a
 *  `CapabilityManifest` yet (owner-set manifest wiring is a later unit), so this renders the honest
 *  no-wallet-budget branch until that lands. */
apiRouter.get('/skills/:id/instructions.md', (c) => {
  const skill = skillsStore.get(c.req.param('id'));
  if (!skill) return c.text('Skill not found', 404);
  return c.text(renderAgentInstructions(skill), 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

apiRouter.get('/skills', (c) => {
  const skills = skillsStore.list().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    mcpUrl: `${config.publicBaseUrl}/api/mcp/${s.id}`,
    skillUrl: `${config.publicBaseUrl}/api/skills/${s.id}/skill.md`,
    toolDefs: s.toolDefs,
    createdAt: s.createdAt,
  }));
  return c.json({ success: true, data: skills });
});

apiRouter.post('/execute', zValidator('json', ExecuteSchema), async (c) => {
  const { params, skillId, sender, agentWallet } = c.req.valid('json');
  const skill = skillsStore.get(skillId);
  if (!skill) return c.json({ success: false, error: 'Skill not found' }, 404);

  const result = await skillRunnerService.runFlow(skill.flow, params, {
    actionId: skill.id,
    sender,
    agentWallet: normalizeAgentWallet(agentWallet),
  });
  // `runFlow` returns a structured refusal (not an ExecutionEnvelope) instead of throwing when
  // strict simulation failed (R3/KTD-4) — surface it honestly as a failed request, not a 200
  // success wrapping something unsignable.
  if ('refused' in result && result.refused) {
    return c.json({ success: false, error: result.reason, data: result }, 422);
  }
  return c.json({ success: true, data: result });
});

apiRouter.post('/setup/prepare', zValidator('json', SetupPrepareSchema), async (c) => {
  const body = c.req.valid('json');
  const skill = skillsStore.get(body.skillId);
  if (!skill) return c.json({ success: false, error: 'Skill not found' }, 404);

  const plan = await prepareSetupPlan(
    skill,
    body.sender,
    BigInt(body.budgetMist),
    BigInt(body.perTxMist),
    body.minimumRemainingMist ? BigInt(body.minimumRemainingMist) : 0n,
    body.expiresAtMs ? BigInt(body.expiresAtMs) : BigInt(Date.now() + 24 * 60 * 60 * 1000),
    body.clientOrderId,
  );
  return c.json({ success: true, data: plan });
});

apiRouter.get('/audit/:blobId', async (c) => {
  const blobId = c.req.param('blobId');
  try {
    const audit = await walrusAuditService.readAuditTrail(blobId);
    return c.json({ success: true, data: audit });
  } catch (err: unknown) {
    // R15: never forward `err.message` to the client — it can embed the blob id, byte counts, raw
    // Zod issue paths, or Walrus/RPC internals. Full detail is logged server-side only; the client
    // gets one generic, stable 404 regardless of WHY the blob was unreadable (missing, oversized,
    // malformed JSON, or schema-invalid all look the same from outside).
    console.error(`[audit] failed to read blob ${blobId}:`, err instanceof Error ? err.message : err);
    return c.json({ success: false, error: 'Audit record not found or unreadable.' }, 404);
  }
});

/**
 * MCP endpoint (Streamable HTTP transport) — works with Thiny (mcpHttpPlugin), Claude Code
 * (`claude mcp add --transport http`), and OpenCode (remote MCP). POST carries JSON-RPC; a GET with
 * an event-stream Accept is the client probing for a server push stream (we don't push → 405, which
 * the MCP SDK handles), while a browser GET is redirected to the human-readable SKILL.md.
 */
apiRouter.get('/mcp/:skillId', (c) => {
  const origin = c.req.header('Origin');
  if (origin && !isAllowedMcpOrigin(origin)) {
    return c.json({ success: false, error: 'Origin not allowed.' }, 403);
  }

  const skillId = c.req.param('skillId');
  if (!skillsStore.get(skillId)) return c.text('Skill not found', 404);
  if ((c.req.header('Accept') || '').includes('text/event-stream')) {
    return c.text('This MCP server does not support a GET event stream.', 405);
  }
  return c.redirect(`${config.publicBaseUrl}/api/skills/${skillId}/skill.md`, 302);
});

apiRouter.post('/mcp/:skillId', async (c) => {
  // R14: validated by exact origin match (never substring/prefix) — see `isAllowedMcpOrigin`. Only
  // enforced when the header is present; non-browser MCP clients typically send none at all.
  const origin = c.req.header('Origin');
  if (origin && !isAllowedMcpOrigin(origin)) {
    return c.json({ success: false, error: 'Origin not allowed.' }, 403);
  }

  const skillId = c.req.param('skillId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  // JSON-RPC batch support (R14): a batch is a JSON array of request objects; the server responds
  // with an array of the corresponding responses, omitting any entry that was a notification (which
  // gets no response at all, batched or not).
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batch must not be empty.' } }, 400);
    }
    const responses = await Promise.all(
      body.map((entry) => handleMcpJsonRpc(skillId, entry as Record<string, unknown>)),
    );
    const nonNull = responses.filter((response): response is Record<string, unknown> => response !== null);
    // A batch made entirely of notifications gets no body — same 202 convention as a single one.
    if (nonNull.length === 0) return c.body(null, 202);
    return c.json(nonNull);
  }

  const response = await handleMcpJsonRpc(skillId, body as Record<string, unknown>);
  // Notifications/responses get no body — reply 202 Accepted per the Streamable HTTP spec.
  if (response === null) return c.body(null, 202);
  return c.json(response);
});
