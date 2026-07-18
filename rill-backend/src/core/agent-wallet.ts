/** On-chain agent wallet binding — optional; when set, PTBs fund via spend() not tx.gas. */

export interface AgentWalletBinding {
  packageId: string;
  walletId: string;
  capId: string;
  /** Full Move type, e.g. 0x2::sui::SUI */
  coinType: string;
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
