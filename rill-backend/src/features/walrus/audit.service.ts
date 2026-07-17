import { createWalrusClient } from '../../core/walrus-client';
import type { FlowGraph } from '../compiler/compiler.service';
import type { SimulationResult } from '../compiler/simulator.service';

export interface AuditRecord {
  version: '1';
  service: 'rill';
  network: string;
  timestamp: string;
  flow: FlowGraph;
  params?: Record<string, unknown>;
  simulation: SimulationResult;
  executed: boolean;
  digest?: string;
  warnings: string[];
}

export class WalrusAuditService {
  async readAuditTrail(blobId: string): Promise<AuditRecord> {
    const client = createWalrusClient();
    const bytes = await client.walrus.readBlob({ blobId });
    return JSON.parse(new TextDecoder().decode(bytes)) as AuditRecord;
  }
}

export const walrusAuditService = new WalrusAuditService();
