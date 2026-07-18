import type { FlowGraph, FlowNode } from './compiler.service';

function isTrueLike(value: unknown): boolean {
  return value === true || value === 'true';
}

export class PreviewService {
  buildPreview(flow: FlowGraph, warnings: string[]): string {
    const lines: string[] = ['Transaction preview:', ''];

    for (const node of flow.nodes) {
      lines.push(this.describeNode(node));
    }

    if (flow.edges.length > 0) {
      lines.push('');
      lines.push('Wiring:');
      for (const edge of flow.edges) {
        lines.push(`  ${edge.source}.${edge.sourceHandle} → ${edge.target}.${edge.targetHandle}`);
      }
    }

    if (warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      for (const w of warnings) {
        lines.push(`  • ${w}`);
      }
    }

    lines.push('');
    lines.push('Atomic: all steps succeed or the entire transaction reverts.');

    return lines.join('\n');
  }

  private describeNode(node: FlowNode): string {
    const config = node.config ?? {};
    switch (node.type) {
      case 'cetus_swap':
        return `- Cetus swap - amount_in: ${config.amount_in ?? '?'} mist, min_out: ${config.min_amount_out ?? '?'} mist`;
      case 'haedal_stake':
        return `- Haedal stake - amount: ${config.amount ?? '?'} mist SUI`;
      case 'deepbook_limit_order':
        return [
          '- DeepBook limit order',
          `pool: ${config.poolKey ?? '?'}`,
          `price: ${config.price ?? '?'}`,
          `quantity: ${config.quantity ?? '?'}`,
          `side: ${isTrueLike(config.isBid) ? 'bid' : 'ask'}`,
          `pay_with_deep: ${isTrueLike(config.payWithDeep)}`,
          `client_order_id: ${config.clientOrderId ?? '?'}`,
          `deposit_sui: ${config.depositSui ?? 0}`,
        ].join(' - ');
      case 'ptb':
        return `- PTB boundary — all wired actions compile into one transaction`;
      case 'guardrail': {
        const min = config.minValue ?? '?';
        const asset = config.coinType ?? 'SUI';
        return `- Guardrail — assert output coin value >= ${min} mist (${asset})`;
      }
      default:
        return `- ${node.type} (unsupported - skipped at compile time)`;
    }
  }
}

export const previewService = new PreviewService();
