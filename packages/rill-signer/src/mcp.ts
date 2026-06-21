#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { loadConfigFromEnv, createSigner, executePtb } from './core';

/**
 * @rill/signer MCP server (stdio) — drop-in for Claude Code, OpenCode, Cursor, any MCP client.
 *
 * Newline-delimited JSON-RPC over stdin/stdout (the MCP stdio transport). Pairs with Rill's hosted
 * build MCP: agent calls `sui_address` → passes it as `sender` to Rill's build tool → gets `unsignedPtb`
 * → calls `sui_execute_ptb` here to sign + submit. Caps enforced on-chain by agent_wallet.
 *
 * Config via env: RILL_SUI_PRIVATE_KEY, SUI_NETWORK (default testnet), SUI_RPC_URL, RILL_ALLOW_MAINNET.
 * stdout is RESERVED for protocol frames — all logs go to stderr.
 */

const cfg = loadConfigFromEnv();
const signer = createSigner(cfg);

const TOOLS = [
  {
    name: 'sui_address',
    description:
      "Return this signer's Sui address + network. Use it as the `sender` when calling Rill's build tool " +
      'so the PTB is built for you to sign.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sui_balance',
    description: "Read a Sui coin balance (defaults to this signer's address and SUI).",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "Owner address (default: this signer's address)." },
        coinType: { type: 'string', description: 'Coin type, e.g. 0x2::sui::SUI (default: SUI).' },
      },
    },
  },
  {
    name: 'sui_execute_ptb',
    description:
      "Sign and submit an unsigned Sui PTB that Rill's builder produced. Re-simulates, applies the soft " +
      'gas policy, then signs + submits with the local key. Pass the builder\'s `unsignedPtb` (base64). ' +
      'On-chain agent_wallet caps may still abort it.',
    inputSchema: {
      type: 'object',
      properties: {
        unsignedPtb: { type: 'string', description: "The builder's unsigned PTB — base64 of a serialized Sui transaction." },
      },
      required: ['unsignedPtb'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'sui_address') {
    if (!signer.address) throw new Error('No key configured. Set RILL_SUI_PRIVATE_KEY (suiprivkey1…).');
    return { address: signer.address, network: signer.network };
  }
  if (name === 'sui_balance') {
    const owner = (typeof args.address === 'string' ? args.address : undefined) ?? signer.address;
    if (!owner) throw new Error('No address given and no key configured.');
    const coinType = typeof args.coinType === 'string' ? args.coinType : undefined;
    const bal = await signer.client.getBalance({ owner, ...(coinType ? { coinType } : {}) });
    return { owner, coinType: bal.coinType, totalBalanceMist: bal.totalBalance, coins: bal.coinObjectCount };
  }
  if (name === 'sui_execute_ptb') {
    const unsignedPtb = String(args.unsignedPtb ?? '');
    if (!unsignedPtb) throw new Error('unsignedPtb is required.');
    return executePtb(unsignedPtb, signer, cfg);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rill-signer', version: '0.1.0' },
      },
    };
  }
  if (method === 'notifications/initialized') return null; // notification → no response
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    try {
      const data = await callTool(String(params.name), params.arguments ?? {});
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false },
      };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
    }
  }
  if (id === null) return null; // unknown notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const rl = createInterface({ input: process.stdin });
console.error(`rill-signer MCP ready — ${signer.network}${signer.address ? ` (${signer.address})` : ' (no key)'}`);
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue; // ignore non-JSON noise
  }
  const response = await handle(msg);
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
}
