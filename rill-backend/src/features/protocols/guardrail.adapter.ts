import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { injectMinOutAssert } from './guard';
import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

export const guardrailAdapter: ProtocolAdapter = {
  nodeType: 'guardrail',

  rootSuiFunding(_node: FlowNode, _flow: FlowGraph): bigint {
    return 0n;
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, node, flow, nodeOutputs, warnings } = ctx;

    const incoming = flow.edges.find((e) => e.target === node.id);
    if (!incoming) return;

    const sourceNode = flow.nodes.find((n) => n.id === incoming.source);
    if (!sourceNode) return;

    const coin = nodeOutputs[sourceNode.id];
    if (coin === undefined) {
      warnings.push(`Guardrail ${node.id}: no output coin from ${sourceNode.id} to guard.`);
      return;
    }

    const minValue = BigInt(node.config?.minValue ?? 0);
    if (minValue <= 0n) return;

    const coinType = String(node.config?.coinType || SUI_COIN_TYPE);
    injectMinOutAssert(tx, coin, coinType, minValue, warnings);
  },
};
