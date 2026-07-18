import { SuiGrpcClient } from '@mysten/sui/grpc';
import dotenv from 'dotenv';
import path from 'node:path';
import { loadAgentWalletFromEnv } from './agent-wallet';

dotenv.config();

/**
 * Absolute path to the `rill-backend` package root (`src/core` is two levels below it) — anchors
 * path-relative config (today: `skillsStorePath`) to the package's own location instead of
 * `process.cwd()` (KTD-7/R7). A monorepo root script, a process manager, or a systemd unit that
 * launches this process from a different working directory must not silently read/write a
 * different `data/skills.json` than the one the operator configured. `import.meta.dir` is bun's
 * `__dirname` equivalent.
 */
const BACKEND_ROOT = path.resolve(import.meta.dir, '..', '..');

// Testnet is the safe default (KTD-7/R7) — an operator must opt INTO mainnet explicitly, not land
// on it by omission. Pairs with `assertBootSafe` below: mainnet additionally requires an explicit
// guard package id, so "no env configured" can never boot pointed at real funds unprotected.
const network = (process.env.SUI_NETWORK || 'testnet') as 'mainnet' | 'testnet';
const DEFAULT_RPC = network === 'testnet'
  ? 'https://fullnode.testnet.sui.io:443'
  : 'https://fullnode.mainnet.sui.io:443';

// Rill's own deployed contracts, keyed by network (like an SDK ships known addresses). Env overrides.
// Mainnet intentionally has no default — deploy + set RILL_GUARD_PACKAGE_ID before going live there.
const KNOWN_GUARD_PACKAGE: Partial<Record<string, string>> = {
  testnet: '0xadec99557cf7771bce94737fdd3ea0bcc989d81e0860f3e69af55433dae8c034',
};

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  network,
  suiRpcUrl: process.env.SUI_RPC_URL || DEFAULT_RPC,
  mainnetRpcUrl: process.env.SUI_MAINNET_RPC_URL || 'https://fullnode.mainnet.sui.io:443',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${parseInt(process.env.PORT || '3000', 10)}`,
  agentWallet: loadAgentWalletFromEnv(),
  /** Published rill_guard package — the on-chain slippage chokepoint (assert_min_value). */
  guardPackageId: process.env.RILL_GUARD_PACKAGE_ID || KNOWN_GUARD_PACKAGE[network],
  /** Where published skills persist across restarts (file-backed store). Always an absolute path,
   *  resolved against `BACKEND_ROOT` (KTD-7) rather than `process.cwd()`. */
  skillsStorePath: path.resolve(BACKEND_ROOT, process.env.SKILLS_STORE_PATH || './data/skills.json'),
  walrusEnabled: (process.env.WALRUS_ENABLED || 'false').toLowerCase() === 'true',
  walrusUploadRelay:
    process.env.WALRUS_UPLOAD_RELAY || 'https://upload-relay.testnet.walrus.space',
  walrusEpochs: parseInt(process.env.WALRUS_EPOCHS || '3', 10),
  walrusMaxTipMist: parseInt(process.env.WALRUS_MAX_TIP_MIST || '5000000', 10),
  walrusExplorerBase:
    process.env.WALRUS_EXPLORER_BASE || 'https://walruscan.com/testnet/blob',
};

/**
 * Fail-fast startup guard (KTD-7, R7): refuses to boot on `mainnet` without a deployed guard
 * package. Every on-chain slippage floor (a guardrail node's `minValue`, a Cetus swap's
 * `min_amount_out`) routes through `rill_guard::assert_min_value` (`features/protocols/guard.ts`'s
 * `injectMinOutAssert`); without a package id there, that call throws mid-compile instead of never
 * happening — so the *real* risk of an unset guard package on mainnet is a fleet of guardrail-only
 * flows that look protected in the UI but 500 on every compile, not a silent no-op. Failing at
 * startup surfaces that misconfiguration immediately instead of per-request.
 *
 * Exported (not just invoked inline below) so `config.test.ts` can pin the exact failure without
 * needing to re-import this module under a different `SUI_NETWORK` — `process.env` is only read
 * once, at module load, so re-triggering that read from a test isn't practical.
 */
export function assertBootSafe(cfg: { network: string; guardPackageId?: string }): void {
  if (cfg.network === 'mainnet' && !cfg.guardPackageId) {
    throw new Error(
      'Refusing to start: SUI_NETWORK=mainnet requires RILL_GUARD_PACKAGE_ID (the deployed '
        + 'rill_guard package) to be set — without it, no guardrail or min_amount_out slippage floor '
        + 'can be enforced on-chain. Deploy rill_guard and set RILL_GUARD_PACKAGE_ID, or unset '
        + 'SUI_NETWORK / set it to "testnet" for local development.',
    );
  }
}

assertBootSafe(config);

export const suiClient = new SuiGrpcClient({ baseUrl: config.suiRpcUrl, network: config.network });
export const mainnetSuiClient = new SuiGrpcClient({ baseUrl: config.mainnetRpcUrl, network: 'mainnet' });
