import type { CapabilityManifest } from '../../../packages/rill-sdk/src/capability-manifest';
import { ValidationError } from './errors';

/** On-chain agent wallet binding — optional; when set, PTBs fund via spend() not tx.gas. */

export interface AgentWalletBinding {
  packageId: string;
  walletId: string;
  capId: string;
  /** Full Move type, e.g. 0x2::sui::SUI */
  coinType: string;
  /**
   * U5/R8 backward-compat gate: when set, the compiler emits the redesigned agent_wallet package's
   * Rule + Hot Potato sequence (`request_spend` -> one `prove` per manifest rule -> `confirm_spend`)
   * instead of the legacy single `agent_wallet::spend()` call. Absent (the default) keeps the
   * CURRENT `spend()` behavior byte-identical — the redesigned package (U1) is not yet deployed, so
   * flows against the live v2 package must keep compiling exactly as they do today.
   */
  capabilityManifest?: CapabilityManifest;
  /**
   * Shared `agent_wallet::version::Version` object id — required when `capabilityManifest` is set.
   * Gates `create_wallet`/`request_spend`/`confirm_spend`/every rule's `prove` (U1).
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
 * place both coexisting agent_wallet packages get resolved (F7, review finding F7's fix):
 *
 *   - No `capabilityManifest` on the input -> today's live v2 binding, byte-identical to before F7:
 *     `packageId`/`walletId`/`capId` pass through exactly as given (no env fallback — a caller that
 *     never mentions a manifest must keep naming its own package explicitly, exactly as it always
 *     has), `coinType` defaults to SUI. `compiler.service.ts` reads this as "no manifest" and keeps
 *     emitting the single legacy `agent_wallet::spend()` call.
 *
 *   - A `capabilityManifest` IS present -> the redesigned Rule + Hot Potato binding
 *     `compiler.service.ts`'s `buildManifestGatedSpend` needs: `packageId` falls back to
 *     `AGENT_WALLET_PACKAGE_ID_REDESIGNED` and `versionId` falls back to `AGENT_WALLET_VERSION_ID`
 *     when the caller doesn't supply its own (the expected common case — a caller knows its
 *     capability manifest, not the redesigned package's deployed address). Either left unresolved
 *     (env unset AND caller silent) throws `ValidationError` (422) HERE, before any PTB command is
 *     ever built — a manifest-gated spend can never be attempted half-configured.
 *
 * Both branches keep coexisting: which one a given request takes depends solely on whether ITS OWN
 * `capabilityManifest` field is present, never on a global server setting.
 */
export function normalizeAgentWallet(input: AgentWalletInput): AgentWalletBinding {
  const coinType = input.coinType ?? SUI_COIN_TYPE;

  if (input.capabilityManifest) {
    const packageId = input.packageId ?? process.env.AGENT_WALLET_PACKAGE_ID_REDESIGNED;
    const versionId = input.versionId ?? process.env.AGENT_WALLET_VERSION_ID;

    if (!packageId) {
      throw new ValidationError(
        'agentWallet.capabilityManifest requires the redesigned agent_wallet package id: supply '
          + 'agentWallet.packageId explicitly, or configure AGENT_WALLET_PACKAGE_ID_REDESIGNED on '
          + 'the server — a manifest-gated spend cannot be built without it.',
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

  if (!input.packageId) {
    throw new ValidationError('agentWallet.packageId is required.');
  }

  return {
    packageId: input.packageId,
    walletId: input.walletId,
    capId: input.capId,
    coinType,
  };
}
