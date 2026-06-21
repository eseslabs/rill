import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
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
import { buildToolDefs } from '../../features/mcp/tool-schema';
import { buildSkillDoc } from '../../features/mcp/skill-doc';
import { handleMcpJsonRpc } from '../../features/mcp/mcp.service';
import { walrusAuditService } from '../../features/walrus/audit.service';
import {
  IntrospectSchema,
  ResolveSchema,
  CompileSchema,
  SimulateSchema,
  PublishSchema,
  ExecuteSchema,
} from '../schemas/api.schema';

export const apiRouter = new Hono();

function resolveAgentWallet(body: { agentWallet?: { packageId: string; walletId: string; capId: string; coinType?: string } }) {
  if (body.agentWallet) {
    return {
      packageId: body.agentWallet.packageId,
      walletId: body.agentWallet.walletId,
      capId: body.agentWallet.capId,
      coinType: body.agentWallet.coinType ?? '0x2::sui::SUI',
    };
  }
  return config.agentWallet;
}

apiRouter.get('/protocols', (c) => {
  return c.json({ success: true, data: getProtocolRegistry(config.network) });
});

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
  const compileResult = await compilerService.compileFlow(body.flow, {
    sender: body.sender,
    agentWallet: resolveAgentWallet(body),
  });

  const preview = previewService.buildPreview(body.flow, compileResult.warnings);
  const unsignedPtb = serializeUnsignedPtb(compileResult.transaction);

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
  const compileResult = await compilerService.compileFlow(body.flow, {
    sender: body.sender ?? DEFAULT_SIMULATE_SENDER,
    agentWallet: resolveAgentWallet(body),
  });

  const simulation = await simulatorService.simulateTransaction(
    compileResult.transaction,
    body.sender,
  );
  const preview = previewService.buildPreview(body.flow, compileResult.warnings);
  const unsignedPtb = serializeUnsignedPtb(compileResult.transaction);

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
  // Publish only needs warnings + tool defs (the compiled tx is discarded), so a placeholder sim
  // sender is fine — the real recipient/sender is supplied by the agent at execute time.
  const { warnings } = await compilerService.compileFlow(flow, { sender: DEFAULT_SIMULATE_SENDER });

  const skillId = `skill_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const toolDefs = buildToolDefs(flow, skillId);
  const mcpUrl = `${config.publicBaseUrl}/api/mcp/${skillId}`;
  const skillUrl = `${config.publicBaseUrl}/api/skills/${skillId}/skill.md`;

  skillsStore.save({
    id: skillId,
    name: toolDefs.name,
    description: toolDefs.description,
    flow,
    toolDefs,
    policyId,
    createdAt: new Date().toISOString(),
  });

  return c.json({
    success: true,
    data: { skillId, mcpUrl, skillUrl, toolDefs, warnings },
  });
});

/** Skill doc — paste this URL into any AI agent (Claude Code, OpenClaw, Hermes, …). */
apiRouter.get('/skills/:id/skill.md', (c) => {
  const skill = skillsStore.get(c.req.param('id'));
  if (!skill) return c.text('Skill not found', 404);
  return c.text(buildSkillDoc(skill), 200, { 'content-type': 'text/markdown; charset=utf-8' });
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
  const body = c.req.valid('json');
  const { flow, params, skillId, execute, forceExecute, sender, agentWallet } = body;

  const targetFlow =
    skillId && skillsStore.get(skillId) ? skillsStore.get(skillId)!.flow : flow;

  if (!targetFlow) {
    return c.json({ success: false, error: 'flow or skillId is required' }, 400);
  }

  const result = await skillRunnerService.runFlow(targetFlow, params ?? {}, {
    execute: execute ?? false,
    forceExecute: forceExecute ?? false,
    sender,
    agentWallet: agentWallet
      ? {
          packageId: agentWallet.packageId,
          walletId: agentWallet.walletId,
          capId: agentWallet.capId,
          coinType: agentWallet.coinType ?? '0x2::sui::SUI',
        }
      : config.agentWallet,
  });

  return c.json({ success: true, data: result });
});

apiRouter.get('/audit/:blobId', async (c) => {
  const blobId = c.req.param('blobId');
  try {
    const audit = await walrusAuditService.readAuditTrail(blobId);
    return c.json({ success: true, data: audit });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to read Walrus audit blob';
    return c.json({ success: false, error: message }, 404);
  }
});

/**
 * MCP endpoint (Streamable HTTP transport) — works with Thiny (mcpHttpPlugin), Claude Code
 * (`claude mcp add --transport http`), and OpenCode (remote MCP). POST carries JSON-RPC; a GET with
 * an event-stream Accept is the client probing for a server push stream (we don't push → 405, which
 * the MCP SDK handles), while a browser GET is redirected to the human-readable SKILL.md.
 */
apiRouter.get('/mcp/:skillId', (c) => {
  const skillId = c.req.param('skillId');
  if (!skillsStore.get(skillId)) return c.text('Skill not found', 404);
  if ((c.req.header('Accept') || '').includes('text/event-stream')) {
    return c.text('This MCP server does not support a GET event stream.', 405);
  }
  return c.redirect(`${config.publicBaseUrl}/api/skills/${skillId}/skill.md`, 302);
});

apiRouter.post('/mcp/:skillId', async (c) => {
  const skillId = c.req.param('skillId');
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const response = await handleMcpJsonRpc(skillId, body);
  // Notifications/responses get no body — reply 202 Accepted per the Streamable HTTP spec.
  if (response === null) return c.body(null, 202);
  return c.json(response);
});
