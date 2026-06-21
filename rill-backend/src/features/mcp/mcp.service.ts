import { skillsStore, PublishedSkill } from './skills.store';
import { skillRunnerService } from './skill-runner.service';
import { config } from '../../core/config';
import { canExecuteOnChain } from './sui-signer';

/** JSON-RPC handler for MCP tools/list + tools/call (Claude Code / OpenCode compatible). */
export async function handleMcpJsonRpc(
  skillId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const skill = skillsStore.get(skillId);
  if (!skill) {
    return { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Skill not found' } };
  }

  const id = body.id ?? null;
  const method = String(body.method ?? '');

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: `rill-${skill.id}`,
          version: '1.0.0',
          description: 'Keyless PTB builder — returns unsigned PTB + preview + simulation.',
        },
      },
    };
  }

  if (method === 'notifications/initialized') {
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
