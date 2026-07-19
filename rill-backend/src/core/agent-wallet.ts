import type { CapabilityManifest } from '../../../packages/rill-sdk/src/capability-manifest';
import { ValidationError } from './errors';

/** On-chain agent wallet binding — optional; when set, PTBs fund via the manifest-gated
 *  request_spend/confirm_spend sequence instead of tx.gas. */

export interface AgentWalletBinding {
  packageId: string;
  walletId: string;
  capId: string;
  /** Full Move type, e.g. 0x2::sui::SUI */
  coinType: string;
  /**
   * There is now ONE agent_wallet package (the redesigned Rule + Hot Potato design) — every bound
   * wallet compiles the `request_spend` -> one `prove` per manifest rule -> `confirm_spend`
   * sequence, never a legacy single `agent_wallet::spend()` call (that package/call no longer
   * exists). `capabilityManifest`/`versionId` are typed optional here only because this interface
   * also describes the transient, not-yet-normalized shape a caller may hand in; `normalizeAgentWallet`
   * below is the ONE place that enforces both are actually present before a binding is used —
   * a wallet bound without a manifest is rejected there (and, defense-in-depth, by the compiler's
   * `buildManifestGatedSpend`) with a `ValidationError`, never a silent legacy fallback.
   */
  capabilityManifest?: CapabilityManifest;
  /**
   * Shared `agent_wallet::version::Version` object id — required whenever a wallet is bound. Gates
   * `create_wallet`/`request_spend`/`confirm_spend`/every rule's `prove`.
   */
  versionId?: string;
}

export function loadAgentWalletFromEnv(): AgentWalletBinding | undefined {
  const packageId = process.env.AGENT_WALLET_PACKAGE_ID;
  const walletId = process.env.AGENT_WALLET_OBJECT_ID;
  const capId = process.env.AGENT_CAP_OBJECT_ID;
  const coinType = process.env.AGENT_WALLET_COIN_TYPE || '0x2::sui::SUI';

  if (!packageId) {
    return undefined;
  }

  return { packageId, walletId: walletId || '', capId: capId || '', coinType };
}

export const SUI_COIN_TYPE = '0x2::sui::SUI';

/**
 * F7: the raw agentWallet shape any transport hands in before it becomes a resolved
 * `AgentWalletBinding` — HTTP's `AgentWalletSchema` (Zod-validated), MCP's `readAgentWallet`
 * (hand-validated, no Zod), or a direct programmatic caller. `packageId` is intentionally optional
 * here even though `AgentWalletBinding.packageId` itself is required: `normalizeAgentWallet` below
 * is the ONE place a manifest-gated caller's missing package id gets resolved from env, so the input
 * type has to allow the field to be absent for that resolution to mean anything.
 */
export interface AgentWalletInput {
  packageId?: string;
  walletId: string;
  capId: string;
  coinType?: string;
  capabilityManifest?: CapabilityManifest;
  versionId?: string;
}

/**
 * Normalizes any transport's raw agentWallet input into a resolved `AgentWalletBinding` — the ONE
 * place a binding gets resolved against the (single) redesigned agent_wallet package.
 *
 * A wallet binding always requires a `capabilityManifest` (KTD-6: there is no honest "no
 * restrictions" default, and there is no more legacy manifest-less `spend()` fallback to fall back
 * to) plus the shared `agent_wallet::version::Version` object id `versionId` gates. `packageId`
 * falls back to `AGENT_WALLET_PACKAGE_ID` and `versionId` falls back to `AGENT_WALLET_VERSION_ID`
 * when the caller doesn't supply its own (the expected common case — a caller knows its capability
 * manifest, not the deployed package/version addresses). A missing manifest, or an unresolved
 * package/version (env unset AND caller silent), throws `ValidationError` (422) HERE, before any PTB
 * command is ever built — a spend can never be attempted half-configured, and a wallet can never be
 * bound without an owner-declared manifest.
 */
export function normalizeAgentWallet(input: AgentWalletInput): AgentWalletBinding {
  const coinType = input.coinType ?? SUI_COIN_TYPE;

  if (!input.capabilityManifest) {
    throw new ValidationError(
      'agentWallet is bound without a capabilityManifest: every agent wallet binding must declare '
        + 'the owner-approved rules it is allowed to spend under — there is no legacy manifest-less '
        + 'spend() fallback. Supply agentWallet.capabilityManifest (e.g. at least a "budget" rule).',
    );
  }

  const packageId = input.packageId ?? process.env.AGENT_WALLET_PACKAGE_ID;
  const versionId = input.versionId ?? process.env.AGENT_WALLET_VERSION_ID;

  if (!packageId) {
    throw new ValidationError(
      'agentWallet.capabilityManifest requires the agent_wallet package id: supply '
        + 'agentWallet.packageId explicitly, or configure AGENT_WALLET_PACKAGE_ID on the server — '
        + 'a manifest-gated spend cannot be built without it.',
    );
  }
  if (!versionId) {
    throw new ValidationError(
      'agentWallet.capabilityManifest requires the shared agent_wallet Version object id: supply '
        + 'agentWallet.versionId explicitly, or configure AGENT_WALLET_VERSION_ID on the server — '
        + 'a manifest-gated spend cannot be built without it.',
    );
  }

  return {
    packageId,
    walletId: input.walletId,
    capId: input.capId,
    coinType,
    capabilityManifest: input.capabilityManifest,
    versionId,
  };
}
