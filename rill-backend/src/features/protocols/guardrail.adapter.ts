import { ValidationError } from '../../core/errors';
import { injectMinOutAssert, resolveGuardrailMinValue } from './guard';
import type { AdapterCtx, FlowGraph, FlowNode, NodeOutput, ProtocolAdapter } from './types';

/**
 * Guardrail — a pass-through coin sink (KTD-3). Asserts every incoming coin meets `minValue`, then
 * (when there is more than one) merges them into a single coin and records THAT as its own output
 * so a downstream node — or the compiler's settle sweep, if nothing downstream consumes it — sees
 * exactly one coin per node, same as every other adapter.
 *
 * A guardrail with zero incoming edges guards the root wallet-spend coin instead; that case is
 * handled by `compiler.service.ts`'s root-budget loop (this adapter returns immediately so the two
 * paths never double-process the same node — R1/KTD-3 dedupe).
 */
export const guardrailAdapter: ProtocolAdapter = {
  nodeType: 'guardrail',

  rootSuiFunding(_node: FlowNode, _flow: FlowGraph): bigint {
    return 0n;
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, node, flow, nodeOutputs, warnings } = ctx;

    const incomingEdges = flow.edges.filter((e) => e.target === node.id);
    if (incomingEdges.length === 0) return; // root-budget guardrail — compiler.service.ts owns it

    const minValue = resolveGuardrailMinValue(node, warnings);

    const collected: NodeOutput[] = [];
    for (const edge of incomingEdges) {
      const upstream = nodeOutputs[edge.source];
      if (upstream === undefined) {
        warnings.push(`Guardrail ${node.id}: no output coin from ${edge.source} to guard.`);
        continue;
      }
      delete nodeOutputs[edge.source]; // consumed — the settle sweep must not also see this entry
      collected.push(upstream);
    }

    if (collected.length === 0) return; // every incoming edge was dangling — nothing to pass through

    const coinType = collected[0].coinType;
    const mismatched = collected.find((c) => c.coinType !== coinType);
    if (mismatched) {
      throw new ValidationError(
        `Guardrail ${node.id}: incoming coins have mismatched types (${coinType} vs `
          + `${mismatched.coinType}) — cannot merge them into one output.`,
      );
    }

    if (minValue > 0n) {
      for (const coin of collected) {
        injectMinOutAssert(tx, coin.value, coin.coinType, minValue, warnings);
      }
    }

    let merged = collected[0].value;
    if (collected.length > 1) {
      tx.mergeCoins(merged as never, collected.slice(1).map((c) => c.value) as never[]);
    }

    nodeOutputs[node.id] = { value: merged, coinType };
  },
};
