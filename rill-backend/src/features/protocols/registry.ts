import { cetusAdapter } from './cetus.adapter';
import { deepbookAdapter } from './deepbook.adapter';
import { guardrailAdapter } from './guardrail.adapter';
import { haedalAdapter } from './haedal.adapter';
import { ptbAdapter } from './ptb.adapter';
import type { ProtocolAdapter } from './types';

export const adapters: Record<string, ProtocolAdapter> = {
  [cetusAdapter.nodeType]: cetusAdapter,
  [haedalAdapter.nodeType]: haedalAdapter,
  [deepbookAdapter.nodeType]: deepbookAdapter,
  [ptbAdapter.nodeType]: ptbAdapter,
  [guardrailAdapter.nodeType]: guardrailAdapter,
};

export function getAdapter(nodeType: string): ProtocolAdapter | undefined {
  return adapters[nodeType];
}
