import type { CapabilityManifest } from '../../../packages/rill-sdk/src/capability-manifest';

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
  /**
   * `request_spend`'s `target_package` metadata — the protocol package this spend authorizes
   * interacting with, checked by an attached `protocol_scope` rule. Required when
   * `capabilityManifest` is set (no safe default: unlike `recipient`, there is no flow-derived
   * fallback that is honest for an arbitrary flow shape).
   */
  targetPackage?: string;
  /**
   * `request_spend`'s `recipient` metadata, checked by an attached `recipient_allowlist` rule.
   * Falls back to `CompileOptions.sender` (the owner) when a manifest is present and this is
   * omitted — a spend's proceeds default to going back to the flow's sender absent a more specific
   * recipient.
   */
  recipient?: string;
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
