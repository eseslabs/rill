import { AppError } from '../../core/errors';
import { DiscoveredFunction } from './types';

export class IntrospectService {
  /**
   * Introspects a Move package and extracts public/entry functions.
   *
   * R15: this build genuinely cannot do this (the gRPC client this backend uses doesn't expose
   * package bytecode) — `/introspect` must say so honestly (501, stable `type`) instead of a plain
   * `Error` that the global handler downgrades to an opaque 500. `/resolve`'s curated manifests
   * (`resolver.service.ts`) don't depend on this method; only its dynamic fallback does, and it now
   * surfaces the same honest 501 instead of a generic crash.
   */
  async introspectPackage(_packageId: string): Promise<DiscoveredFunction[]> {
    const err = new AppError(
      'Move package introspection is not supported in this build — the gRPC client used here does '
        + 'not expose package bytecode/ABI. Use /resolve with a curated packageId/moduleName/'
        + 'functionName (e.g. Cetus, Haedal) instead of dynamic discovery.',
      501,
    );
    err.name = 'NotImplemented';
    throw err;
  }
}

export const introspectService = new IntrospectService();
