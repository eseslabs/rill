import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { SUI_CLOCK_ID } from '../../core/protocols';
import { resolveCetusSwapConfig } from '../../core/node-config';
import { pickSwapFunction, resolvePoolTypeArgs } from '../compiler/pool-resolver';
import { injectMinOutAssert } from './guard';
import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

/**
 * Cetus CLMM swap. Builds `router::swap` directly (zero-coin pattern), so it composes into the same
 * PTB and is funded from agent_wallet::spend() / tx.gas. Pool + coin types come from node config
 * (FE/agent supplies them); server defaults are fallback only.
 */
export const cetusAdapter: ProtocolAdapter = {
  nodeType: 'cetus_swap',

  rootSuiFunding(node: FlowNode, flow: FlowGraph): bigint {
    const hasCoinEdge = flow.edges.some(
      (e) => e.target === node.id && e.targetHandle === 'coin_inputs',
    );
    if (hasCoinEdge) return 0n;
    const { config } = resolveCetusSwapConfig(node);
    if (config.inputCoinType !== SUI_COIN_TYPE) return 0n;
    return BigInt(config.amount_in);
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, flow, node, nodeOutputs, options, warnings, fundSuiCoin } = ctx;
    const { config: swapCfg, warnings: cfgWarnings } = resolveCetusSwapConfig(node);
    warnings.push(...cfgWarnings);

    const amountIn = BigInt(swapCfg.amount_in);
    const poolId = swapCfg.pool;
    const inputCoinType = swapCfg.inputCoinType;

    const poolTypes = await resolvePoolTypeArgs(poolId);
    const swap = pickSwapFunction(inputCoinType, poolTypes, swapCfg.minSqrtPrice, swapCfg.maxSqrtPrice);
    const hasDownstream = flow.edges.some((e) => e.source === node.id);

    const coinInputEdge = flow.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'coin_inputs',
    );
    let coinInputArg: unknown;

    if (coinInputEdge) {
      coinInputArg = nodeOutputs[coinInputEdge.source];
      if (coinInputArg === undefined) {
        throw new Error(
          `Node ${node.id}: upstream coin from ${coinInputEdge.source} is missing — ensure swap uses router::swap (wire coin_out → sui_coin).`,
        );
      }
    } else if (inputCoinType !== SUI_COIN_TYPE) {
      throw new Error(
        `Node ${node.id}: non-SUI input (${inputCoinType}) requires an upstream coin edge. Use Token in = SUI for standalone swap.`,
      );
    } else {
      coinInputArg = fundSuiCoin(amountIn);
    }

    const feedsHaedal = flow.edges.some(
      (e) =>
        e.source === node.id &&
        flow.nodes.some((n) => n.id === e.target && n.type === 'haedal_stake'),
    );
    if (feedsHaedal && swap.outputCoinType !== SUI_COIN_TYPE) {
      throw new Error(
        `Node ${node.id}: swap wired to Haedal stake must output SUI (set Token out = SUI / Token in = USDC).`,
      );
    }

    // router::swap consumes both A and B inputs; the side we're not funding gets a zero coin.
    // Create ONLY the zero coin we actually pass — an extra unused zero aborts execute
    // (UnusedValueWithoutDrop), which devInspect does not catch.
    const zero = (coinType: string) =>
      tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinType], arguments: [] });
    const [coinAIn, coinBIn] = swap.a2b
      ? [coinInputArg, zero(poolTypes.coinTypeB)]
      : [zero(poolTypes.coinTypeA), coinInputArg];

    const [outA, outB] = tx.moveCall({
      target: `${swapCfg.integratePackageId}::router::swap`,
      typeArguments: swap.typeArguments,
      arguments: [
        tx.object(swapCfg.globalConfigId),
        tx.object(poolId),
        coinAIn as never,
        coinBIn as never,
        tx.pure.bool(swap.a2b),
        tx.pure.bool(swapCfg.by_amount_in ?? true),
        tx.pure.u64(amountIn),
        tx.pure.u128(BigInt(swapCfg.sqrt_price_limit ?? swap.sqrtPriceLimit)),
        tx.pure.bool(false),
        tx.object(SUI_CLOCK_ID),
      ],
    });

    const outputCoin = swap.a2b ? outB : outA;
    const leftoverCoin = swap.a2b ? outA : outB;
    const leftoverType = swap.a2b ? poolTypes.coinTypeA : poolTypes.coinTypeB;
    nodeOutputs[node.id] = outputCoin;

    // On-chain slippage floor: abort if the swap output is below min_amount_out (borrows the coin,
    // so it stays usable below). Deterministic backstop against bad fills / sandwich MEV.
    injectMinOutAssert(tx, outputCoin, swap.outputCoinType, BigInt(swapCfg.min_amount_out), warnings);

    // Settle a coin: SUI merges back to gas; anything else goes to the owner. Both swap outputs MUST be
    // consumed or the PTB aborts on execute with UnusedValueWithoutDrop (devInspect won't catch this).
    const settle = (coin: unknown, coinType: string) => {
      if (coinType === SUI_COIN_TYPE) {
        tx.mergeCoins(tx.gas, [coin as never]);
      } else {
        if (!options.sender) {
          throw new Error(
            `Node ${node.id}: swap produces a non-SUI coin (${coinType}) with no recipient — pass \`sender\` (the owner address) so it isn't lost.`,
          );
        }
        tx.transferObjects([coin as never], options.sender);
      }
    };

    // The input-remainder coin (≈0 after an exact-in swap) must always be settled.
    settle(leftoverCoin, leftoverType);

    // The output coin: hand to a downstream node (via nodeOutputs) or settle it here.
    if (!hasDownstream) {
      settle(outputCoin, swap.outputCoinType);
    }
  },
};
