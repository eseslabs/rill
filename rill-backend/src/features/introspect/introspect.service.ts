import { suiClient } from '../../core/config';
import { DiscoveredFunction, MoveParameter } from './types';

export class IntrospectService {
  /**
   * Introspects a Move package and extracts public/entry functions.
   */
  async introspectPackage(_packageId: string): Promise<DiscoveredFunction[]> {
    throw new Error('Move package introspection is not supported over gRPC in this build.');
  }
}

export const introspectService = new IntrospectService();
