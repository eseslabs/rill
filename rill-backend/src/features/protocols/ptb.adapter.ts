import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

/**
 * PTB is the default and only transaction shape (R7) — `CompilerService.compileFlow` already
 * builds exactly one `Transaction` per flow regardless of node content, so a `ptb` node never
 * changes what gets compiled. This adapter exists purely for backward tolerance: a flow saved by
 * an as-yet-unupdated frontend may still carry a legacy `ptb` node, and it must be accepted and
 * silently ignored — not an error, not a warning — so already-published flows keep compiling once
 * the frontend drops the node. There is deliberately no other logic here (no "multiple PTB nodes"
 * warning, no special-casing); a `ptb` node contributes nothing.
 */
export const ptbAdapter: ProtocolAdapter = {
  nodeType: 'ptb',

  rootSuiFunding(_node: FlowNode, _flow: FlowGraph): bigint {
    return 0n;
  },

  async build(_ctx: AdapterCtx): Promise<void> {
    // No-op by design — see module doc comment.
  },
};
