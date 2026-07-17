import { ValidationError } from '../../core/errors';
import type { FlowGraph, FlowNode } from './compiler.service';
import type { ManifestCall } from './manifest';

export class PreviewService {
  /**
   * Renders the preview from `manifest` — which was decoded back out of the compiled PTB —
   * so the preview cannot describe a call the bytes do not contain. `flow` supplies human
   * labels only; no value in the output is ever read from node config.
   */
  buildPreview(flow: FlowGraph, manifest: ManifestCall[], warnings: string[]): string {
    if (manifest.length === 0) {
      throw new ValidationError('This flow compiled to no on-chain calls; refusing to preview it.');
    }

    const lines: string[] = ['Transaction preview:', ''];
    lines.push(`${manifest.length} on-chain call(s), in execution order:`);
    for (const call of manifest) {
      const types = call.typeArguments.length > 0 ? `<${call.typeArguments.join(', ')}>` : '';
      const amounts = call.u64Args.length > 0 ? ` amounts=[${call.u64Args.join(', ')}]` : '';
      lines.push(`  ${call.index + 1}. ${call.target}${types}${amounts}`);
    }

    const labels = flow.nodes.map((node) => this.describeNode(node)).filter(Boolean);
    if (labels.length > 0) {
      lines.push('', 'Intent (labels only — values above are read from the compiled bytes):');
      for (const label of labels) lines.push(`  • ${label}`);
    }

    if (warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const w of warnings) lines.push(`  • ${w}`);
    }

    lines.push('', 'Atomic: all steps succeed or the entire transaction reverts.');
    return lines.join('\n');
  }

  /**
   * A bare human label for a node. Deliberately carries no amounts, addresses, or object ids:
   * every value in the preview must come from the compiled bytes via the manifest, never from
   * node config, or preview and PTB can disagree again.
   */
  private describeNode(node: FlowNode): string {
    switch (node.type) {
      case 'cetus_swap':
        return 'Cetus swap';
      case 'haedal_stake':
        return 'Haedal stake';
      case 'deepbook_limit_order':
        return 'DeepBook limit order';
      case 'ptb':
        return 'PTB boundary — all wired actions compile into one transaction';
      case 'guardrail':
        return 'Guardrail — assert output coin value meets the compiled minimum';
      default:
        return `${node.type} (unsupported - skipped at compile time)`;
    }
  }
}

export const previewService = new PreviewService();
