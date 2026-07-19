import type { Transaction } from '@mysten/sui/transactions';
import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { SUI_CLOCK_ID } from '../../core/protocols';
import { suiClient } from '../../core/config';
import { parseConfigU128, parseConfigU64, resolveCetusSwapConfig } from '../../core/node-config';
import { ValidationError } from '../../core/errors';
import { pickSwapFunction, resolvePoolTypeArgs } from '../compiler/pool-resolver';
import { injectMinOutAssert } from './guard';
import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

/** Hard cap on `listCoins` pagination in `sourceCoinFromSender` (R13) — a wallet with pathologically
 *  many small coin objects of the same type must not turn one compile request into an unbounded
 *  number of upstream RPC calls; fail with a clear, actionable error instead of hanging/looping. */
const MAX_COIN_LIST_PAGES = 10;

/**
 * Source an exact `amount` of a non-SUI coin from the sender's owned coins: gather coin objects of the
 * type, merge them, and split the amount. Produces a plain PTB (no unresolved intents → serializes for
 * keyless signing). Used for standalone swaps where the input token isn't SUI (e.g. USDC → SUI).
 */
async function sourceCoinFromSender(
  tx: Transaction,
  sender: string,
  coinType: string,
  amount: bigint,
  nodeId: string,
): Promise<unknown> {
  const ids: string[] = [];
  let total = 0n;
  let cursor: string | null | undefined = undefined;
  let pages = 0;
  do {
    pages += 1;
    if (pages > MAX_COIN_LIST_PAGES) {
      throw new ValidationError(
        `Node ${nodeId}: ${sender}'s ${coinType} coins span more than ${MAX_COIN_LIST_PAGES} pages `
          + `without covering the requested ${amount} — refusing to page through the sender's coin `
          + `list unboundedly. Merge the sender's coins of this type first, or fund from a wallet `
          + `with fewer, larger coin objects.`,
      );
    }
    const page = await suiClient.listCoins({ owner: sender, coinType, cursor: cursor ?? null });
    for (const c of page.objects) {
      ids.push(c.objectId);
      total += BigInt(c.balance);
      if (total >= amount) break;
    }
    cursor = total >= amount || !page.hasNextPage ? null : page.cursor;
  } while (cursor);

  if (ids.length === 0 || total < amount) {
    const symbol = coinType.split('::').pop() || coinType;
    // A dry-run runs against a placeholder/zero sender (no wallet bound yet) that owns nothing — so a
    // swap whose INPUT is a non-SUI coin (e.g. USDC→SUI, as any swap feeding a Haedal stake must be)
    // has no coin to source. This isn't a compile bug: a simulation can't mint balances. Say exactly
    // that and point at the two paths that DO dry-run cleanly, instead of a raw hex dump.
    if (total === 0n) {
      throw new ValidationError(
        `Node ${nodeId}: can't dry-run this swap — it spends ${symbol}, but the simulation sender `
          + `holds none (a dry-run can't create token balances). Two flows that simulate cleanly: a `
          + `SUI→${symbol === 'SUI' ? 'USDC' : 'SUI'} swap (funded from gas), or bind an agent wallet `
          + `that already holds the ${symbol}.`,
      );
    }
    throw new ValidationError(
      `Node ${nodeId}: insufficient ${symbol} balance for ${sender} (have ${total}, need ${amount}).`,
    );
  }
  const [primary, ...rest] = ids;
  const primaryRef = tx.object(primary);
  if (rest.length) tx.mergeCoins(primaryRef, rest.map((id) => tx.object(id)));
  const [split] = tx.splitCoins(primaryRef, [amount]);
  return split;
}

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
    return parseConfigU64(config.amount_in, `Node ${node.id}: config.amount_in`);
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, flow, node, nodeOutputs, extraCoins, options, warnings, fundSuiCoin } = ctx;
    const { config: swapCfg, warnings: cfgWarnings } = resolveCetusSwapConfig(node);
    warnings.push(...cfgWarnings);

    const amountIn = parseConfigU64(swapCfg.amount_in, `Node ${node.id}: config.amount_in`);
    const poolId = swapCfg.pool;
    const inputCoinType = swapCfg.inputCoinType;

    const poolTypes = await resolvePoolTypeArgs(poolId);
    const swap = pickSwapFunction(inputCoinType, poolTypes, swapCfg.minSqrtPrice, swapCfg.maxSqrtPrice);

    const coinInputEdge = flow.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'coin_inputs',
    );
    let coinInputArg: unknown;

    if (coinInputEdge) {
      const upstream = nodeOutputs[coinInputEdge.source];
      if (upstream === undefined) {
        const sourceNode = flow.nodes.find((n) => n.id === coinInputEdge.source);
        if (sourceNode?.type === 'guardrail') {
          // A guardrail with nothing to forward (it guards the root budget, not a real coin) feeding
          // an action is the documented "guardrail-before-action" gap — guarding a coin flowing INTO
          // an action isn't supported yet (project-context.md). Degrade to normal root funding
          // instead of a hard failure so the edge's presence is reported, not fatal.
          warnings.push(
            `Node ${node.id}: guardrail ${coinInputEdge.source} has no coin to forward (guarding a `
              + `coin flowing into a downstream action isn't supported yet) — funding from the root `
              + `budget instead.`,
          );
          coinInputArg = fundSuiCoin(amountIn);
        } else {
          throw new ValidationError(
            `Node ${node.id}: upstream coin from ${coinInputEdge.source} is missing — ensure swap uses router::swap (wire coin_out → sui_coin).`,
          );
        }
      } else {
        delete nodeOutputs[coinInputEdge.source]; // consumed — keep the sweep from settling it too
        coinInputArg = upstream.value;
      }
    } else if (inputCoinType !== SUI_COIN_TYPE) {
      // Standalone swap with a non-SUI input → source it from the sender's own coins of that type.
      if (!options.sender) {
        throw new ValidationError(
          `Node ${node.id}: non-SUI input (${inputCoinType}) needs a sender to source the coin from — pass \`sender\`.`,
        );
      }
      coinInputArg = await sourceCoinFromSender(tx, options.sender, inputCoinType, amountIn, node.id);
    } else {
      coinInputArg = fundSuiCoin(amountIn);
    }

    // Must match the SAME handle Haedal's own adapter reads from (targetHandle === 'sui_coin') so
    // this pre-check can never disagree with what actually gets consumed downstream.
    const feedsHaedal = flow.edges.some(
      (e) =>
        e.source === node.id &&
        e.targetHandle === 'sui_coin' &&
        flow.nodes.some((n) => n.id === e.target && n.type === 'haedal_stake'),
    );
    if (feedsHaedal && swap.outputCoinType !== SUI_COIN_TYPE) {
      throw new ValidationError(
        `Node ${node.id}: swap wired to Haedal stake must output SUI (set Token out = SUI / Token in = USDC).`,
      );
    }

    // R7: min_amount_out has no server default — a 1-mist "floor" is not real slippage protection.
    // It's only safe to omit when a downstream guardrail node will assert its own floor on this
    // swap's output coin (same handle contract as `feedsHaedal` above, so this can never disagree
    // with what the guardrail adapter actually consumes).
    const feedsGuardrail = flow.edges.some(
      (e) =>
        e.source === node.id &&
        e.sourceHandle === 'coin_out' &&
        flow.nodes.some((n) => n.id === e.target && n.type === 'guardrail'),
    );
    if (!swapCfg.min_amount_out && !feedsGuardrail) {
      throw new ValidationError(
        `Node ${node.id}: config.min_amount_out is required — Cetus swaps need an explicit slippage `
          + `floor unless the output coin (coin_out) is wired into a downstream guardrail node that `
          + `asserts its own minimum. Set config.min_amount_out, or wire coin_out → a guardrail's `
          + `"in" handle.`,
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
        tx.pure.u128(
          parseConfigU128(
            swapCfg.sqrt_price_limit ?? swap.sqrtPriceLimit,
            `Node ${node.id}: config.sqrt_price_limit`,
          ),
        ),
        tx.pure.bool(false),
        tx.object(SUI_CLOCK_ID),
      ],
    });

    const outputCoin = swap.a2b ? outB : outA;
    const leftoverCoin = swap.a2b ? outA : outB;
    const leftoverType = swap.a2b ? poolTypes.coinTypeA : poolTypes.coinTypeB;

    // On-chain slippage floor: abort if the swap output is below min_amount_out (borrows the coin,
    // so it stays usable below). Deterministic backstop against bad fills / sandwich MEV. Absent
    // here only when `feedsGuardrail` is true (checked above) — the downstream guardrail asserts its
    // own floor on this exact coin later in the same PTB, so skipping a redundant assert here is safe.
    if (swapCfg.min_amount_out) {
      const minAmountOut = parseConfigU64(swapCfg.min_amount_out, `Node ${node.id}: config.min_amount_out`);
      injectMinOutAssert(tx, outputCoin, swap.outputCoinType, minAmountOut, warnings);
    }

    // Single owner of settlement is the compiler's sweep (KTD-3) — this adapter only ever RECORDS
    // coins it produces, never merges/transfers them itself:
    //  - the real output is chainable, so it goes in `nodeOutputs` (a downstream node may consume
    //    it, deleting the entry; whatever is left unconsumed after every node builds gets swept);
    //  - the opposite-side leftover (≈0 after an exact-in swap) is never chainable — it goes
    //    straight to `extraCoins`, which the sweep always consumes.
    nodeOutputs[node.id] = { value: outputCoin, coinType: swap.outputCoinType };
    extraCoins.push({ value: leftoverCoin, coinType: leftoverType });
  },
};
