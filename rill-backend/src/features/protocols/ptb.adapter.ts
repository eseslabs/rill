import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

export const ptbAdapter: ProtocolAdapter = {
  nodeType: 'ptb',

  rootSuiFunding(_node: FlowNode, _flow: FlowGraph): bigint {
    return 0n;
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { node, flow, warnings } = ctx;
    const ptbCount = flow.nodes.filter((n) => n.type === 'ptb').length;
    if (ptbCount > 1) {
      warnings.push(`PTB node ${node.id}: multiple PTB nodes detected; only one transaction boundary is expected.`);
    }
  },
};
