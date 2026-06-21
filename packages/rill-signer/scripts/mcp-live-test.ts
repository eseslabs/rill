#!/usr/bin/env bun
/**
 * @rill/signer — live MCP-path battle-test.
 *
 * Spawns the stdio MCP server (src/mcp.ts) and drives it like a real MCP client:
 *   1. initialize handshake
 *   2. sui_execute_ptb with a REAL unsignedPtb from Rill /api/compile → asserts on-chain success (digest)
 *   3. sui_execute_ptb with a PTB that fails re-simulation → asserts isError + NO submission (guard holds)
 *
 * Env: RILL_SUI_PRIVATE_KEY, AGENT_WALLET_PACKAGE_ID (unused here), RILL_BACKEND (default :3002), SUI_NETWORK.
 */
const BACKEND = process.env.RILL_BACKEND || 'http://localhost:3002';
const KEY = process.env.RILL_SUI_PRIVATE_KEY!;
const NETWORK = process.env.SUI_NETWORK || 'testnet';
if (!KEY) throw new Error('Set RILL_SUI_PRIVATE_KEY');

// Derive sender from the key (so Rill builds the PTB for us).
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
const ME = Ed25519Keypair.fromSecretKey(KEY).getPublicKey().toSuiAddress();

let passed = 0;
let failed = 0;
const check = (c: boolean, label: string, d = '') => {
  if (c) { passed++; console.log(`  ✅ ${label} ${d}`); } else { failed++; console.log(`  ❌ ${label} ${d}`); }
};

async function compile(minAmountOut: string): Promise<string> {
  const res = await fetch(`${BACKEND}/api/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: ME,
      flow: { nodes: [{ id: 'n1', type: 'cetus_swap', inputs: { amount_in: '20000000', min_amount_out: minAmountOut } }], edges: [] },
    }),
  });
  const json = await res.json();
  const ptb = (json.data ?? json).unsignedPtb;
  if (!ptb) throw new Error(`compile failed: ${JSON.stringify(json).slice(0, 300)}`);
  return ptb;
}

// Minimal stdio MCP client over the spawned server.
class McpClient {
  private proc = Bun.spawn(['bun', 'run', `${import.meta.dir}/../src/mcp.ts`], {
    env: { ...process.env, RILL_SUI_PRIVATE_KEY: KEY, SUI_NETWORK: NETWORK },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  private buf = '';
  private pending = new Map<number, (msg: any) => void>();
  private reader = this.proc.stdout.getReader();

  constructor() { this.pump(); }
  private async pump() {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.buf += dec.decode(value, { stream: true });
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const cb = this.pending.get(msg.id);
        if (cb) { this.pending.delete(msg.id); cb(msg); }
      }
    }
  }
  call(id: number, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      this.proc.stdin.flush();
    });
  }
  notify(method: string) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); this.proc.stdin.flush(); }
  kill() { this.proc.kill(); }
}

async function main() {
  console.log(`@rill/signer MCP live test — ${NETWORK}`);
  console.log(`  sender: ${ME}\n`);
  const mcp = new McpClient();

  const init = await mcp.call(1, 'initialize', {});
  check(init.result?.serverInfo?.name === 'rill-signer', 'initialize handshake');
  mcp.notify('notifications/initialized');

  // 1) success path: real swap PTB, min_out 0 → should sign + submit on-chain
  console.log('1) sui_execute_ptb — valid swap (expect on-chain success)');
  const goodPtb = await compile('0');
  const r1 = await mcp.call(2, 'tools/call', { name: 'sui_execute_ptb', arguments: { unsignedPtb: goodPtb } });
  const t1 = r1.result?.content?.[0]?.text ?? '';
  let digest = '';
  try { digest = JSON.parse(t1).digest ?? ''; } catch { /* */ }
  check(r1.result?.isError === false && !!digest, 'valid PTB signed + submitted', digest ? `digest ${digest}` : `(${t1.slice(0, 120)})`);

  // 2) slippage path: unsatisfiable min_out → rill_guard aborts on-chain → re-sim fails →
  //    signer must reject WITHOUT submitting. Proves the guard + the signer's sim-guard together.
  console.log('2) sui_execute_ptb — unsatisfiable min_out (expect slippage reject, NO submit)');
  const badPtb = await compile('999999999999999');
  const r2 = await mcp.call(3, 'tools/call', { name: 'sui_execute_ptb', arguments: { unsignedPtb: badPtb } });
  const t2 = r2.result?.content?.[0]?.text ?? '';
  const rejected = r2.result?.isError === true && !t2.includes('"digest"');
  check(rejected, 'slippage floor rejected before signing (no submit)', `(${t2.slice(0, 90)})`);

  mcp.kill();
  console.log(`\n──────── RESULT: ${passed} passed, ${failed} failed ────────`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
