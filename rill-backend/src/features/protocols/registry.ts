import { cetusAdapter } from './cetus.adapter';
import { haedalAdapter } from './haedal.adapter';
import { deepbookAdapter } from './deepbook.adapter';
import type { ProtocolAdapter } from './types';

/**
 * Protocol adapter registry — keyed by flow node type.
 * **Add a new protocol = add its adapter here.** Nothing else in the compiler changes.
 */
export const adapters: Record<string, ProtocolAdapter> = {
  [cetusAdapter.nodeType]: cetusAdapter,
  [haedalAdapter.nodeType]: haedalAdapter,
  [deepbookAdapter.nodeType]: deepbookAdapter,
};

export function getAdapter(nodeType: string): ProtocolAdapter | undefined {
  return adapters[nodeType];
}
