#!/usr/bin/env bun
import { loadConfigFromEnv, createSigner, executeUnsafePtb } from './core';

/**
 * rill-sign — CLI wrapper over the signer core (for shell agents + skills like OpenClaw/Hermes).
 *
 *   rill-sign address              → print the signer's Sui address (use as Rill's `sender`)
 *   rill-sign --unsafe-ptb <ptb>   → development-only raw sign + submit
 */
async function main() {
  const cfg = loadConfigFromEnv();
  const signer = createSigner(cfg);
  const command = process.argv[2];

  if (command === 'address' || command === '--address') {
    if (!signer.address) throw new Error('No key configured. Set RILL_SUI_PRIVATE_KEY (suiprivkey1…).');
    process.stdout.write(JSON.stringify({ address: signer.address, network: signer.network }) + '\n');
    return;
  }

  if (command !== '--unsafe-ptb') {
    process.stderr.write('usage: rill-sign address | rill-sign --unsafe-ptb BASE64_PTB\n');
    process.exit(2);
  }
  const unsignedPtb = String(process.argv[3] ?? '').trim();
  if (!unsignedPtb) throw new Error('BASE64_PTB is required after --unsafe-ptb.');
  process.stderr.write(
    'warning: unsafe raw PTB path bypasses ExecutionEnvelope policy; never use for Demo Day.\n',
  );
  const result = await executeUnsafePtb(unsignedPtb, signer, cfg);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`rill-sign: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
