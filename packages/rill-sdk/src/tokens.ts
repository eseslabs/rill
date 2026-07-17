/**
 * Token registry — the single source of truth for coin decimals across Rill.
 *
 * KTD-2 (see docs/plans/2026-07-17-001-fix-audit-hardening-plan.md): backend, frontend, and signer
 * all resolve `{coinType, symbol, decimals}` through this table instead of hardcoding conversion
 * factors inline. Keyed by the full Move coin type (`<address>::<module>::<name>`) because that is
 * the only identifier that is unambiguous across networks and across otherwise-same-symbol coins.
 *
 * Scope: only the coins Rill's own adapters/config actually touch today (enumerated from
 * `rill-backend/src/core/protocols.ts`, `rill-backend/src/features/protocols/{deepbook,cetus,haedal}.adapter.ts`,
 * and `rill-frontend/src/lib/action-config.ts`) — not the full coin catalog `@mysten/deepbook-v3` ships.
 */

export interface TokenInfo {
  /** Full Move coin type, e.g. `0x2::sui::SUI`. Registry key. */
  coinType: string;
  /** Display symbol. Not unique — multiple coinTypes may share a symbol (e.g. the two testnet "USDC"s). */
  symbol: string;
  /** Base-unit exponent: `1 <symbol> == 10^decimals base units`. */
  decimals: number;
}

export const TOKENS: readonly TokenInfo[] = [
  {
    // Native SUI gas coin. Used by agent_wallet::spend, Haedal staking, DeepBook deposits, Cetus swaps.
    // Source: rill-backend/src/core/agent-wallet.ts SUI_COIN_TYPE; @mysten/deepbook-v3
    // testnetCoins.SUI.scalar / mainnetCoins.SUI.scalar === 1_000_000_000.
    coinType: '0x2::sui::SUI',
    symbol: 'SUI',
    decimals: 9,
  },
  {
    // DeepBook's testnet mock USDC quote coin (poolKey "SUI_DBUSDC" etc.) — NOT the same coin as the
    // Cetus testnet USDC below; distinct package address.
    // Source: @mysten/deepbook-v3 testnetCoins.DBUSDC.scalar === 1_000_000.
    coinType: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
    symbol: 'DBUSDC',
    decimals: 6,
  },
  {
    // Mainnet USDC — this single coinType is shared by both DeepBook (mainnetCoins.USDC) and Cetus
    // (protocols.ts MAINNET.cetus.defaultCoinTypeA); they resolve to the identical on-chain address.
    // Source: @mysten/deepbook-v3 mainnetCoins.USDC.scalar === 1_000_000.
    coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    symbol: 'USDC',
    decimals: 6,
  },
  {
    // Cetus's testnet swap-pool USDC (rill-backend/src/core/protocols.ts TESTNET.cetus.defaultCoinTypeA;
    // rill-frontend/src/lib/action-config.ts SWAP_TOKENS) — a different coin from DBUSDC above.
    // No `scalar`/decimals metadata for this address ships in @mysten/deepbook-v3 (it is Cetus-only, not
    // a DeepBook-listed coin) and nothing in-repo pins its decimals independently. Assumed 6, matching
    // every other USDC-symbol coin in this table (mainnet USDC and DBUSDC are both 6) and the ecosystem-
    // wide USDC convention; unlike the other entries this one is an inference, not a directly-sourced value.
    coinType: '0x14a71d857b34677a7d57e0feb303df1adb515a37780645ab763d42ce8d1a5e48::usdc::USDC',
    symbol: 'USDC',
    decimals: 6,
  },
  {
    // WAL — surfaced via rill-backend/src/core/protocols.ts getProtocolRegistry().deepbook_limit_order.coins
    // (testnet) through @mysten/deepbook-v3's testnetCoins/testnetPools (e.g. pool "WAL_DBUSDC").
    // Source: @mysten/deepbook-v3 testnetCoins.WAL.scalar === 1_000_000_000.
    coinType: '0x9ef7676a9f81937a52ae4b2af8d511a28a0b080477c0c2db40b0ab8882240d76::wal::WAL',
    symbol: 'WAL',
    decimals: 9,
  },
  {
    // WAL — mainnet counterpart, surfaced the same way via mainnetCoins/mainnetPools.
    // Source: @mysten/deepbook-v3 mainnetCoins.WAL.scalar === 1_000_000_000.
    coinType: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    symbol: 'WAL',
    decimals: 9,
  },
] as const;

const TOKEN_REGISTRY: ReadonlyMap<string, TokenInfo> = new Map(
  TOKENS.map((token) => [token.coinType, token]),
);

/** Look up a token by its full Move coin type. Returns `undefined` for unknown coin types. */
export function findToken(coinType: string): TokenInfo | undefined {
  return TOKEN_REGISTRY.get(coinType);
}
