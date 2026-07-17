import { parseConfigU64, resolveHaedalStakeConfig } from '../../core/node-config';
import { ValidationError } from '../../core/errors';
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
    return parseConfigU64(config.amount, `Node ${node.id}: config.amount`);
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, flow, node, nodeOutputs, warnings, fundSuiCoin } = ctx;
    const { config: stakeCfg, warnings: cfgWarnings } = resolveHaedalStakeConfig(node);
    warnings.push(...cfgWarnings);

    const amount = parseConfigU64(stakeCfg.amount, `Node ${node.id}: config.amount`);
    const minStake = parseConfigU64(stakeCfg.minStakeMist, `Node ${node.id}: config.minStakeMist`);
    if (amount < minStake) {
      throw new ValidationError(`Haedal minimum stake is ${minStake} mist. Got ${amount}.`);
    }

    const coinInputEdge = flow.edges.find(
      (e) => e.target === node.id && e.targetHandle === 'sui_coin',
    );
    let coinInputArg: unknown;

    if (coinInputEdge) {
      const upstream = nodeOutputs[coinInputEdge.source];
      if (upstream === undefined) {
        const sourceNode = flow.nodes.find((n) => n.id === coinInputEdge.source);
        if (sourceNode?.type === 'guardrail') {
          // Documented gap: a guardrail with nothing to forward (root-budget mode) feeding an
          // action isn't a supported "guard a coin flowing into an action" pattern yet — degrade to
          // normal root funding instead of a hard failure so the edge's presence is still reported.
          warnings.push(
            `Node ${node.id}: guardrail ${coinInputEdge.source} has no coin to forward (guarding a `
              + `coin flowing into a downstream action isn't supported yet) — funding from the root `
              + `budget instead.`,
          );
          coinInputArg = fundSuiCoin(amount);
        } else {
          throw new ValidationError(
            `Node ${node.id}: missing SUI coin from ${coinInputEdge.source} — wire swap coin_out → sui_coin.`,
          );
        }
      } else {
        delete nodeOutputs[coinInputEdge.source]; // consumed — keep the sweep from settling it too
        coinInputArg = upstream.value;
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
