import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Non-privileged, persisted onboarding display settings. `autoCreateRunSets` used to live here and
 * was flippable at runtime via the `set_onboarding_config` MCP tool — that was the R8 finding: an
 * agent-facing surface could enable unattended signing of backend-supplied onboarding PTBs. It is no
 * longer part of this persisted shape; see `isAutoOnboardingAllowed` below.
 */
export interface OnboardingConfig {
  maxAutoSetupBudgetMist: string;
  allowTestnetFaucet: boolean;
}

const DEFAULT_CONFIG: OnboardingConfig = {
  maxAutoSetupBudgetMist: '2000000000',
  allowTestnetFaucet: true,
};

export function configDir(): string {
  return join(process.env.RILL_CONFIG_DIR ?? process.cwd(), '.rill');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadOnboardingConfig(): OnboardingConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OnboardingConfig>;
  return {
    maxAutoSetupBudgetMist: parsed.maxAutoSetupBudgetMist ?? DEFAULT_CONFIG.maxAutoSetupBudgetMist,
    allowTestnetFaucet: parsed.allowTestnetFaucet ?? DEFAULT_CONFIG.allowTestnetFaucet,
  };
}

/**
 * Persists only the two non-privileged fields, reading them out by name rather than spreading the
 * input object — so a caller that still passes a stray `autoCreateRunSets` (e.g. an old client, or a
 * hostile one) can never get it written to disk. This is a second layer behind the MCP tool's own
 * argument allowlist in mcp.ts, not a replacement for it.
 */
export function saveOnboardingConfig(config: Partial<OnboardingConfig>): OnboardingConfig {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = loadOnboardingConfig();
  const next: OnboardingConfig = {
    maxAutoSetupBudgetMist: config.maxAutoSetupBudgetMist ?? current.maxAutoSetupBudgetMist,
    allowTestnetFaucet: config.allowTestnetFaucet ?? current.allowTestnetFaucet,
  };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/**
 * Whether the signer may auto-create run-sets, i.e. sign and submit backend-supplied onboarding PTBs
 * (create_wallet, balance-manager creation, trade-cap mint) without a human confirming each one.
 *
 * Fail-closed, launch-time only: resolves solely from RILL_ALLOW_AUTO_ONBOARDING, exact string
 * "true" required (any other value, including "TRUE" or "1", is false) — mirroring the
 * RILL_ALLOW_MAINNET / RILL_REQUIRE_SIM_SUCCESS precedent in core.ts's loadConfigFromEnv. There is no
 * runtime/MCP path that can flip this: it is read fresh from process.env on every call, but nothing
 * in this process ever writes to RILL_ALLOW_AUTO_ONBOARDING, so in practice it is fixed for the life
 * of the process by whoever launched it.
 */
export function isAutoOnboardingAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.RILL_ALLOW_AUTO_ONBOARDING === 'true';
}

/**
 * Rill supports two custody models: `bounded` (default) — a budget-capped, revocable on-chain
 * AgentWallet — and `direct` (opt-in) — the agent's local keypair holds funds directly, which is
 * strictly LESS safe (no on-chain budget cap, per-tx cap, expiry, or revoke).
 */
export type CustodyMode = 'bounded' | 'direct';

/**
 * Resolves the active custody mode. Fail-safe-to-the-safer-mode: only the exact string "direct"
 * opts into direct-fund custody — any other value (unset, "DIRECT", "1", a typo) stays `bounded`.
 * This mirrors the exact-string, launch-time env gating used by isAutoOnboardingAllowed /
 * RILL_ALLOW_MAINNET: the safer default must never be bypassed by an almost-right value.
 */
export function loadCustodyMode(env: Record<string, string | undefined> = process.env): CustodyMode {
  return env.RILL_CUSTODY_MODE === 'direct' ? 'direct' : 'bounded';
}
