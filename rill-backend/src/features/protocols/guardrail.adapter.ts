import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { ValidationError } from '../../core/errors';
import { injectMinOutAssert } from './guard';
import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

export const guardrailAdapter: ProtocolAdapter = {
  nodeType: 'guardrail',

  rootSuiFunding(_node: FlowNode, _flow: FlowGraph): bigint {
    return 0n;
  },

  /**
   * Fails closed. A node the canvas labels "Guardrail" either emits a real on-chain
   * `rill_guard::assert_min_value`, or the compile is rejected. It must never compile
   * to nothing while the picture still shows a guard.
   */
  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, node, flow, nodeOutputs, warnings } = ctx;

    const incoming = flow.edges.find((e) => e.target === node.id);
    if (!incoming) {
      throw new ValidationError(
        `Guardrail ${node.id} is not wired to anything. Wire it downstream of an action that outputs a coin, or remove it.`,
      );
    }

    const sourceNode = flow.nodes.find((n) => n.id === incoming.source);
    if (!sourceNode) {
      throw new ValidationError(
        `Guardrail ${node.id} is wired to unknown node ${incoming.source}.`,
      );
    }

    const coin = nodeOutputs[sourceNode.id];
    if (coin === undefined) {
      throw new ValidationError(
        `Guardrail ${node.id} is wired to ${sourceNode.id}, which produces no coin to guard. ` +
          `A guardrail must sit downstream of an action that outputs a coin.`,
      );
    }

    const minValue = BigInt(node.config?.minValue ?? 0);
    if (minValue <= 0n) {
      throw new ValidationError(
        `Guardrail ${node.id} has no minimum value configured. A guardrail without a floor enforces nothing; ` +
          `set minValue or remove the node.`,
      );
    }

    const coinType = String(node.config?.coinType || SUI_COIN_TYPE);
    injectMinOutAssert(tx, coin, coinType, minValue, warnings);
  },
};
