import { expect, test } from 'bun:test';
import { RillClient } from '../src/client';
import { RillApiError } from '../src/errors';
import type { ActionToolDefinition, ActionToolName } from '../src/types';

test('callSkill calls build_action with the exact public build input', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new RillClient({
    baseUrl: 'https://rill.test/api',
    fetch: (async (url, init) => {
      request = { url: String(url), init };
      return Response.json({
        jsonrpc: '2.0',
        id: 7,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ version: '1' }) }],
          isError: false,
        },
      });
    }) as typeof fetch,
  });
  const input = {
    sender: '0x1',
    agentWallet: { packageId: '0x2', walletId: '0x3', capId: '0x4' },
    params: { poolKey: 'SUI_DBUSDC' },
    execute: true,
  };

  await client.callSkill('skill_deepbook', input, 7);

  expect(request?.url).toBe('https://rill.test/api/mcp/skill_deepbook');
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'build_action',
      arguments: {
        actionId: 'skill_deepbook',
        sender: input.sender,
        agentWallet: input.agentWallet,
        params: input.params,
      },
    },
  });
});

test('callSkill throws RillApiError for a structured tool rejection', async () => {
  const client = new RillClient({
    baseUrl: 'https://rill.test/api',
    fetch: (async () => Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'fallback rejection' }],
        structuredContent: {
          code: 'build_rejected',
          message: 'Simulation is not a verified success.',
        },
        isError: true,
      },
    })) as typeof fetch,
  });

  try {
    await client.callSkill('skill_deepbook', {
      sender: '0x1',
      agentWallet: { packageId: '0x2', walletId: '0x3', capId: '0x4' },
      params: {},
    });
    throw new Error('Expected callSkill to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(RillApiError);
    expect(error).toMatchObject({
      message: 'Simulation is not a verified success.',
      status: 400,
      type: 'build_rejected',
    });
  }
});

test('listTools types the remote action tool contract', async () => {
  const client = new RillClient({
    baseUrl: 'https://rill.test/api',
    fetch: (async () => Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'list_actions', description: 'List actions', inputSchema: { type: 'object' } },
          { name: 'describe_action', description: 'Describe', inputSchema: { type: 'object' } },
          { name: 'build_action', description: 'Build', inputSchema: { type: 'object' } },
        ],
      },
    })) as typeof fetch,
  });

  const { tools } = await client.listTools('skill_deepbook', 1);
  const names: ActionToolName[] = tools.map((tool: ActionToolDefinition) => tool.name);
  expect(names).toEqual(['list_actions', 'describe_action', 'build_action']);
});

test('callSkill falls back to text for an unstructured tool rejection', async () => {
  const client = new RillClient({
    baseUrl: 'https://rill.test/api',
    fetch: (async () => Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'Local policy rejected the envelope.' }],
        isError: true,
      },
    })) as typeof fetch,
  });

  await expect(client.callSkill('skill_deepbook', {
    sender: '0x1',
    agentWallet: { packageId: '0x2', walletId: '0x3', capId: '0x4' },
    params: {},
  })).rejects.toMatchObject({
    message: 'Local policy rejected the envelope.',
    type: 'McpToolError',
  });
});
