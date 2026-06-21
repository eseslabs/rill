#!/usr/bin/env bun
import { loadConfigFromEnv, createSigner, executePtb } from './core';

/**
 * rill-sign — CLI wrapper over the signer core (for shell agents + skills like OpenClaw/Hermes).
 *
 *   rill-sign address              → print the signer's Sui address (use as Rill's `sender`)
 *   rill-sign <unsignedPtb>        → sign + submit; prints JSON { digest, status, explorerUrl }
 *   echo <unsignedPtb> | rill-sign → same, reading the PTB from stdin
 */
async function main() {
  const cfg = loadConfigFromEnv();
  const signer = createSigner(cfg);
  const arg = process.argv[2];

  if (arg === 'address' || arg === '--address') {
    if (!signer.address) throw new Error('No key configured. Set RILL_SUI_PRIVATE_KEY (suiprivkey1…).');
    process.stdout.write(JSON.stringify({ address: signer.address, network: signer.network }) + '\n');
    return;
  }

  const unsignedPtb = (arg ?? (await Bun.stdin.text())).trim();
  if (!unsignedPtb) {
    process.stderr.write('usage: rill-sign <unsignedPtb>  |  rill-sign address  |  echo <ptb> | rill-sign\n');
    process.exit(2);
  }

  const result = await executePtb(unsignedPtb, signer, cfg);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`rill-sign: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
