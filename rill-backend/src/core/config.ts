import { SuiGrpcClient } from '@mysten/sui/grpc';
import dotenv from 'dotenv';
import { loadAgentWalletFromEnv } from './agent-wallet';

dotenv.config();

const network = (process.env.SUI_NETWORK || 'mainnet') as 'mainnet' | 'testnet';
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
  /** Where published skills persist across restarts (file-backed store). */
  skillsStorePath: process.env.SKILLS_STORE_PATH || './data/skills.json',
  walrusEnabled: (process.env.WALRUS_ENABLED || 'false').toLowerCase() === 'true',
  walrusUploadRelay:
    process.env.WALRUS_UPLOAD_RELAY || 'https://upload-relay.testnet.walrus.space',
  walrusEpochs: parseInt(process.env.WALRUS_EPOCHS || '3', 10),
  walrusMaxTipMist: parseInt(process.env.WALRUS_MAX_TIP_MIST || '5000000', 10),
  walrusExplorerBase:
    process.env.WALRUS_EXPLORER_BASE || 'https://walruscan.com/testnet/blob',
};

export const suiClient = new SuiGrpcClient({ baseUrl: config.suiRpcUrl, network: config.network });
export const mainnetSuiClient = new SuiGrpcClient({ baseUrl: config.mainnetRpcUrl, network: 'mainnet' });
