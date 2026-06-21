import { FlowGraph, FlowNode } from '../compiler/compiler.service';

export function extractExposedParams(flow: FlowGraph) {
  const params: { name: string; type: string; description: string }[] = [];

  for (const node of flow.nodes) {
    if (node.type === 'cetus_swap') {
      params.push({
        name: 'amount_in',
        type: 'number',
        description: 'Amount of input coin to swap (mist)',
      });
      params.push({
        name: 'min_amount_out',
        type: 'number',
        description: 'Minimum output amount (slippage floor, mist)',
      });
    }
    if (node.type === 'haedal_stake') {
      params.push({
        name: 'amount',
        type: 'number',
        description: 'Amount of SUI to stake (mist)',
      });
    }
  }

  return params;
}

export function buildToolDefs(flow: FlowGraph, skillId: string) {
  const exposedParams = extractExposedParams(flow);
  const nodeTypes = flow.nodes.map((n: FlowNode) => n.type).join(' → ');

  return {
    name: `rill_${skillId}`,
    description: `Execute composed Sui flow: ${nodeTypes}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...exposedParams.reduce(
          (acc, p) => {
            acc[p.name] = { type: p.type, description: p.description };
            return acc;
          },
          {} as Record<string, { type: string; description: string }>,
        ),
        sender: {
          type: 'string',
          description:
            "The agent's Sui address. The PTB is built for this sender (tx sender + output recipient) " +
            'so the agent can sign + execute it. Omit for preview-only.',
        },
        execute: {
          type: 'boolean',
          description: 'If true, sign and submit on-chain after simulation (requires local signer).',
        },
      },
      required: exposedParams.map((p) => p.name),
    },
  };
}
