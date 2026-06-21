import { skillsStore, PublishedSkill } from './skills.store';
import { skillRunnerService } from './skill-runner.service';
import { config } from '../../core/config';
import { canExecuteOnChain } from './sui-signer';

/** Protocol versions Rill speaks; echo the client's if known, else fall back to the latest. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = '2025-03-26';

/**
 * MCP JSON-RPC handler — compatible with the official MCP SDK's Streamable HTTP transport, so the
 * same endpoint works for Thiny (`mcpHttpPlugin`), Claude Code (`--transport http`), and OpenCode
 * (remote MCP). Returns `null` for notifications (the caller replies HTTP 202 with no body, per spec).
 */
export async function handleMcpJsonRpc(
  skillId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const id = body.id ?? null;
  const method = String(body.method ?? '');

  // Notifications (no `id`, e.g. notifications/initialized) get no JSON-RPC response.
  if (method.startsWith('notifications/') || id === null) {
    return null;
  }

  const skill = skillsStore.get(skillId);
  if (!skill) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Skill not found' } };
  }

  if (method === 'initialize') {
    const requested = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    const protocolVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: `rill-${skill.id}`,
          version: '1.0.0',
          description: 'Keyless PTB builder — returns unsigned PTB + preview + simulation.',
        },
      },
    };
  }

  // MCP liveness check.
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [formatToolListing(skill)],
      },
    };
  }

  if (method === 'tools/call') {
    const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const args = { ...(params.arguments ?? {}) };
    const wantsExecute = args.execute === true;
    delete args.execute;
    // The agent's address: the PTB is built for this sender (tx sender + output recipient), so the
    // agent can sign it. Without it the server falls back to the simulate sender (preview only).
    const sender = typeof args.sender === 'string' ? args.sender : undefined;
    delete args.sender;

    const devSignAvailable = config.devSignEnabled && canExecuteOnChain();
    const shouldExecute = wantsExecute && devSignAvailable;

    const result = await skillRunnerService.runFlow(skill.flow, args, {
      execute: shouldExecute,
      forceExecute: shouldExecute,
      sender,
      agentWallet: config.agentWallet,
    });

    if (wantsExecute && !devSignAvailable) {
      result.warnings.push(
        'execute=true ignored — keyless mode. Sign result.unsignedPtb via Thiny (@thiny/plugin-sui).',
      );
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.simulation.ok && !result.executed,
      },
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function formatToolListing(skill: PublishedSkill) {
  return {
    name: skill.toolDefs.name,
    description: `${skill.toolDefs.description} Returns unsigned PTB — sign locally (Thiny).`,
    inputSchema: skill.toolDefs.inputSchema,
  };
}
