import { resolveHaedalStakeConfig } from '../../core/node-config';
import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

/** Haedal liquid staking — stake SUI for haSUI. Consumes a SUI coin, produces no chainable output. */
export const haedalAdapter: ProtocolAdapter = {
  nodeType: 'haedal_stake',

  rootSuiFunding(node: FlowNode, flow: FlowGraph): bigint {
    const hasCoinEdge = flow.edges.some(
      (e) => e.target === node.id && e.targetHandle === 'sui_coin',
    );
    if (hasCoinEdge) return 0n;
    const { config } = resolveHaedalStakeConfig(node);
    return BigInt(config.amount);
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, flow, node, nodeOutputs, warnings, fundSuiCoin } = ctx;
    const { config: stakeCfg, warnings: cfgWarnings } = resolveHaedalStakeConfig(node);
    warnings.push(...cfgWarnings);

    const amount = BigInt(stakeCfg.amount);
    const minStake = BigInt(stakeCfg.minStakeMist);
    if (amount < minStake) {
      throw new Error(`Haedal minimum stake is ${minStake} mist. Got ${amount}.`);
    }

    const coinInputEdge = flow.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'sui_coin',
    );
    let coinInputArg: unknown;

    if (coinInputEdge) {
      coinInputArg = nodeOutputs[coinInputEdge.source];
      if (coinInputArg === undefined) {
        throw new Error(
          `Node ${node.id}: missing SUI coin from ${coinInputEdge.source} — wire swap coin_out → sui_coin.`,
        );
      }
    } else {
      coinInputArg = fundSuiCoin(amount);
    }

    tx.moveCall({
      target: stakeCfg.stakeTarget,
      typeArguments: [],
      arguments: [
        tx.object(stakeCfg.suiSystemStateId),
        tx.object(stakeCfg.stakingObjectId),
        coinInputArg as never,
        tx.pure.address(stakeCfg.validator ?? '0x0'),
      ],
    });
  },
};
