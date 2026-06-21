import { testnetPools, mainnetPools, testnetCoins, mainnetCoins } from '@mysten/deepbook-v3';

/** Curated protocol addresses — verified via Sui RPC + official docs. */

const MAINNET = {
  cetus: {
    /** Cetus integrate package — pool_script + router */
    integratePackageId: '0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3',
    /** @deprecated legacy script package — devInspect version-check fails; use integrate */
    scriptPackageId: '0x3a5aa90ffa33d09100d7b6941ea1c0ffe6ab66e77062ddd26320c1b073aabb10',
    clmmPackageId: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
    globalConfigId: '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f',
    /** USDC/SUI mainnet pool */
    defaultPoolId: '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105',
    defaultInputCoinType: '0x2::sui::SUI',
    defaultCoinTypeA: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    defaultCoinTypeB: '0x2::sui::SUI',
    minSqrtPrice: '4295048016',
    maxSqrtPrice: '79226673515401279992447579055',
  },
  haedal: {
    packageId: '0x126e4cfb051cad744706df590ec399e8c02b6feae195c35b8b496280d5442a62',
    suiSystemStateId: '0x5',
    stakingObjectId: '0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca',
  },
} as const;

const TESTNET = {
  cetus: {
    integratePackageId: '0xab2d58dd28ff0dc19b18ab2c634397b785a38c342a8f5065ade5f53f9dbffa1c',
    scriptPackageId: '0xab2d58dd28ff0dc19b18ab2c634397b785a38c342a8f5065ade5f53f9dbffa1c',
    clmmPackageId: '0x5372d555ac734e272659136c2a0cd3227f9b92de67c80dc11250307268af2db8',
    globalConfigId: '0xc6273f844b4bc258952c4e477697aa12c918c8e08106fac6b934811298c9820a',
    /** USDC/SUI testnet pool — verified via on-chain SwapEvent */
    defaultPoolId: '0x2603c08065a848b719f5f465e40dbef485ec4fd9c967ebe83a7565269a74a2b2',
    defaultInputCoinType: '0x2::sui::SUI',
    defaultCoinTypeA: '0x14a71d857b34677a7d57e0feb303df1adb515a37780645ab763d42ce8d1a5e48::usdc::USDC',
    defaultCoinTypeB: '0x2::sui::SUI',
    minSqrtPrice: '4295048016',
    maxSqrtPrice: '79226673515401279992447579055',
  },
  haedal: {
    packageId: '0x0a6ff2b974e08b65649d334c38db5ca046b78b4a5d892087740b9cdb3eb08e47',
    suiSystemStateId: '0x5',
    stakingObjectId: '0xb399662ac5d3973256a1e8629a913336449a2baa16847502ce6bdbf4a0003f07',
  },
} as const;

const network = (process.env.SUI_NETWORK || 'mainnet') as 'mainnet' | 'testnet';
const active = network === 'testnet' ? TESTNET : MAINNET;

export const CETUS = active.cetus;
export const HAEDAL = {
  ...active.haedal,
  stakeTarget: `${active.haedal.packageId}::interface::request_stake`,
  /** Haedal rejects stakes below 1 SUI (abort code 4). */
  minStakeMist: 1_000_000_000n,
} as const;

export const SUI_CLOCK_ID = '0x6';
export const SUI_NETWORK = network;

/** 32-byte zero address — a valid sender for keyless devInspect dry-runs (no real funds involved). */
export const ZERO_ADDRESS = `0x${'0'.repeat(64)}`;
export const DEFAULT_SIMULATE_SENDER = process.env.SIMULATE_SENDER || ZERO_ADDRESS;

/** Network defaults exposed to clients — FE should pass these in flow node config at compile time. */
export function getProtocolRegistry(net: 'mainnet' | 'testnet' = SUI_NETWORK) {
  const cetus = net === 'testnet' ? TESTNET.cetus : MAINNET.cetus;
  const haedal = net === 'testnet' ? TESTNET.haedal : MAINNET.haedal;
  return {
    network: net,
    cetus_swap: {
      integratePackageId: cetus.integratePackageId,
      globalConfigId: cetus.globalConfigId,
      defaultPoolId: cetus.defaultPoolId,
      defaultInputCoinType: cetus.defaultInputCoinType,
      tokens: [
        { symbol: 'SUI', coinType: cetus.defaultCoinTypeB },
        { symbol: 'USDC', coinType: cetus.defaultCoinTypeA },
      ],
      minSqrtPrice: cetus.minSqrtPrice,
      maxSqrtPrice: cetus.maxSqrtPrice,
    },
    haedal_stake: {
      packageId: haedal.packageId,
      stakeTarget: `${haedal.packageId}::interface::request_stake`,
      suiSystemStateId: haedal.suiSystemStateId,
      stakingObjectId: haedal.stakingObjectId,
      minStakeMist: '1000000000',
      coinType: '0x2::sui::SUI',
    },
    deepbook_limit_order: {
      // Pools/coins come from the DeepBook SDK (no hardcoded ids). Requires a funded BalanceManager.
      pools: Object.keys(net === 'testnet' ? testnetPools : mainnetPools),
      coins: Object.keys(net === 'testnet' ? testnetCoins : mainnetCoins),
      requiresBalanceManager: true,
      note: 'Provision + fund a BalanceManager (onboarding); pass balanceManagerId + poolKey + price/quantity/isBid.',
    },
  };
}
