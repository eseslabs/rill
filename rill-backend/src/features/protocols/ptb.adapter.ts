import { ValidationError } from '../../core/errors';
import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

export const ptbAdapter: ProtocolAdapter = {
  nodeType: 'ptb',

  rootSuiFunding(_node: FlowNode, _flow: FlowGraph): bigint {
    return 0n;
  },

  /**
   * A flow always compiles to exactly one Programmable Transaction Block, so a single PTB
   * node is a visual boundary marker with no compile effect. Two or more describe a
   * transaction shape the compiler cannot produce, so the compile is rejected rather than
   * silently emitting one PTB and leaving the canvas claiming otherwise.
   */
  async build(ctx: AdapterCtx): Promise<void> {
    const ptbCount = ctx.flow.nodes.filter((n) => n.type === 'ptb').length;
    if (ptbCount > 1) {
      throw new ValidationError(
        `This flow has ${ptbCount} PTB nodes, but a flow compiles to exactly one Programmable ` +
          `Transaction Block. Remove the extra PTB nodes, or split the flow into separate skills.`,
      );
    }
  },
};
