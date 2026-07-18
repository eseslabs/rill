import { DiscoveredFunction, MoveParameter } from './types';
import { CETUS, HAEDAL, SUI_CLOCK_ID } from '../../core/protocols';
import { introspectService } from './introspect.service';

export interface ResolvedParameter extends MoveParameter {
  role: string | null;
  boundType: 'exact' | 'min' | 'max' | 'none';
  boundOf: string | null;
  exposure: 'fixed' | 'agent_input' | 'default' | 'auto';
  default: any | null;
  confidence: number;
  provenance: 'type' | 'event' | 'statistical' | 'source' | 'manual';
}

export interface ResolvedManifest {
  packageId: string;
  module: string;
  functionName: string;
  packageVersion: string;
  resolvedAt: string;
  typeParameters: { index: number; abilities: string[] }[];
  parameters: ResolvedParameter[];
  emits: string[];
  touches: {
    coinTypes: string[];
    sharedObjects: string[];
  };
  safety: {
    spendingLimitDefault: number | null;
    requiresConfirmation: boolean;
  };
}

const CURATED_MANIFESTS: Record<string, ResolvedManifest> = {
  // R15: `pool_script::swap_a2b` is deprecated (fails Cetus's own devInspect package-version check
  // — see `CETUS.scriptPackageId`'s `@deprecated` note in `core/protocols.ts`); the manifest now
  // describes what `cetus.adapter.ts` actually calls: `router::swap` (zero-coin pattern, both sides
  // passed every call — the unfunded side is a `0x2::coin::zero` coin, see `cetus.adapter.ts`).
  'cetus_swap': {
    packageId: CETUS.integratePackageId,
    module: 'router',
    functionName: 'swap',
    packageVersion: '1',
    resolvedAt: new Date().toISOString(),
    typeParameters: [
      { index: 0, abilities: ['key', 'store'] },
      { index: 1, abilities: ['key', 'store'] }
    ],
    parameters: [
      {
        index: 0,
        name: 'global_config',
        moveType: `${CETUS.clmmPackageId}::config::GlobalConfig`,
        class: 'object',
        role: 'global_config',
        boundType: 'none',
        boundOf: null,
        exposure: 'auto',
        default: CETUS.globalConfigId,
        confidence: 1.0,
        provenance: 'type'
      },
      {
        index: 1,
        name: 'pool',
        moveType: `${CETUS.clmmPackageId}::pool::Pool<T0, T1>`,
        class: 'object',
        role: 'liquidity_pool',
        boundType: 'none',
        boundOf: null,
        exposure: 'fixed',
        default: CETUS.defaultPoolId,
        confidence: 1.0,
        provenance: 'type'
      },
      {
        index: 2,
        name: 'coin_a',
        moveType: '0x2::coin::Coin<T0>',
        class: 'coin',
        role: 'coin_in_a',
        boundType: 'none',
        boundOf: null,
        exposure: 'agent_input',
        default: null,
        confidence: 1.0,
        provenance: 'type'
      },
      {
        index: 3,
        name: 'coin_b',
        moveType: '0x2::coin::Coin<T1>',
        class: 'coin',
        role: 'coin_in_b',
        boundType: 'none',
        boundOf: null,
        exposure: 'agent_input',
        default: null,
        confidence: 1.0,
        provenance: 'type'
      },
      {
        index: 4,
        name: 'a2b',
        moveType: 'bool',
        class: 'pure',
        role: 'direction_a_to_b',
        boundType: 'none',
        boundOf: null,
        exposure: 'fixed',
        default: true,
        confidence: 1.0,
        provenance: 'source'
      },
      {
        index: 5,
        name: 'by_amount_in',
        moveType: 'bool',
        class: 'pure',
        role: 'by_amount_in',
        boundType: 'none',
        boundOf: null,
        exposure: 'fixed',
        default: true,
        confidence: 1.0,
        provenance: 'source'
      },
      {
        index: 6,
        name: 'amount',
        moveType: 'u64',
        class: 'pure',
        role: 'amount_in',
        boundType: 'exact',
        boundOf: 'amount_in',
        exposure: 'agent_input',
        default: 0,
        confidence: 1.0,
        provenance: 'event'
      },
      {
        index: 7,
        name: 'sqrt_price_limit',
        moveType: 'u128',
        class: 'pure',
        role: 'price_limit',
        boundType: 'none',
        boundOf: null,
        exposure: 'fixed',
        default: CETUS.minSqrtPrice,
        confidence: 1.0,
        provenance: 'statistical'
      },
      {
        // Undocumented upstream — `cetus.adapter.ts` always passes `false` here but we don't have
        // a confirmed semantic for this argument, so it's flagged low-confidence rather than
        // asserted as fact.
        index: 8,
        name: 'swap_partner',
        moveType: 'bool',
        class: 'pure',
        role: 'swap_partner_flag',
        boundType: 'none',
        boundOf: null,
        exposure: 'fixed',
        default: false,
        confidence: 0.6,
        provenance: 'source'
      },
      {
        index: 9,
        name: 'clock',
        moveType: '0x2::clock::Clock',
        class: 'system',
        role: 'clock',
        boundType: 'none',
        boundOf: null,
        exposure: 'auto',
        default: SUI_CLOCK_ID,
        confidence: 1.0,
        provenance: 'type'
      }
    ],
    emits: [
      `${CETUS.clmmPackageId}::pool::SwapEvent`
    ],
    touches: {
      coinTypes: ['T0', 'T1'],
      sharedObjects: [`${CETUS.clmmPackageId}::pool::Pool`, CETUS.globalConfigId]
    },
    safety: {
      spendingLimitDefault: 1000000000,
      requiresConfirmation: false
    }
  },
  'haedal_stake': {
    packageId: HAEDAL.packageId,
    module: 'interface',
    functionName: 'request_stake',
    packageVersion: '1',
    resolvedAt: new Date().toISOString(),
    typeParameters: [],
    parameters: [
      {
        index: 0,
        name: 'sui_system',
        moveType: '0x3::sui_system::SuiSystemState',
        class: 'object',
        role: 'sui_system_state',
        boundType: 'none',
        boundOf: null,
        exposure: 'auto',
        default: HAEDAL.suiSystemStateId,
        confidence: 1.0,
        provenance: 'type'
      },
      {
        index: 1,
        name: 'staking',
        moveType: `${HAEDAL.packageId}::staking::Staking`,
        class: 'object',
        role: 'staking_pool',
        boundType: 'none',
        boundOf: null,
        exposure: 'fixed',
        default: HAEDAL.stakingObjectId,
        confidence: 1.0,
        provenance: 'type'
      },
      {
        index: 2,
        name: 'sui_coin',
        moveType: '0x2::coin::Coin<0x2::sui::SUI>',
        class: 'coin',
        role: 'coin_in',
        boundType: 'none',
        boundOf: null,
        exposure: 'agent_input',
        default: null,
        confidence: 1.0,
        provenance: 'type'
      },
      {
        index: 3,
        name: 'validator',
        moveType: 'address',
        class: 'pure',
        role: 'validator_address',
        boundType: 'none',
        boundOf: null,
        exposure: 'fixed',
        default: '0x0',
        confidence: 1.0,
        provenance: 'source'
      }
    ],
    emits: [
      `${HAEDAL.packageId}::staking::UserStaked`
    ],
    touches: {
      coinTypes: ['0x2::sui::SUI'],
      sharedObjects: [HAEDAL.stakingObjectId, HAEDAL.suiSystemStateId]
    },
    safety: {
      spendingLimitDefault: 1000000000,
      requiresConfirmation: false
    }
  }
};

export class ResolverService {
  /**
   * Resolves semantics for a single function in a package.
   */
  async resolveSemantics(packageId: string, moduleName: string, functionName: string): Promise<ResolvedManifest> {
    const curatedKey = this.findCuratedKey(packageId, moduleName, functionName);
    if (curatedKey && CURATED_MANIFESTS[curatedKey]) {
      return CURATED_MANIFESTS[curatedKey];
    }
    return this.resolveDynamic(packageId, moduleName, functionName);
  }

  /**
   * R15: exact match on packageId + module + function (not the previous `includes()` substring
   * check) — a bare substring match on hex fragments like `'3a5aa9'`/`'1eabed'` or on the literal
   * word `'cetus'` (which never appears in a real hex address) risked matching an unrelated package
   * that merely shares those characters, or a function whose name merely contains "swap"/"stake" as
   * a substring (e.g. `flash_swap`, `unstake`). `CETUS`/`HAEDAL` are network-aware (`core/protocols.ts`
   * picks testnet/mainnet ids from `SUI_NETWORK`), so this matches correctly on either network.
   */
  private findCuratedKey(packageId: string, moduleName: string, functionName: string): string | null {
    const p = packageId.toLowerCase();
    const m = moduleName.toLowerCase();
    const f = functionName.toLowerCase();
    const cetusPackageIds = [CETUS.integratePackageId, CETUS.clmmPackageId, CETUS.scriptPackageId]
      .map((id) => id.toLowerCase());

    if (cetusPackageIds.includes(p) && m === 'router' && f === 'swap') {
      return 'cetus_swap';
    }
    if (p === HAEDAL.packageId.toLowerCase() && m === 'interface' && f === 'request_stake') {
      return 'haedal_stake';
    }
    return null;
  }

  private async resolveDynamic(packageId: string, moduleName: string, functionName: string): Promise<ResolvedManifest> {
    const resolvedAt = new Date().toISOString();
    
    // 1. Introspect package to get function signature
    const discoveredFunctions = await introspectService.introspectPackage(packageId);
    const func = discoveredFunctions.find(
      f => f.module === moduleName && f.name === functionName
    );

    if (!func) {
      throw new Error(`Function ${moduleName}::${functionName} not found in package ${packageId}`);
    }

    // 2. Historical-transaction event-matching is not implemented over gRPC in this build (R15) —
    // `resolveDynamic` degrades gracefully to the same result it would reach after an unconditional
    // failure: every `pure` param stays unmatched (`matches` empty, `processedTxCount` 0), so
    // step 3 below falls through to its lower-confidence, non-event-derived naming for every field.
    const matches: Record<number, Record<string, number>> = {};
    const emits = new Set<string>();
    const processedTxCount = 0;

    // 3. Construct resolved parameters list
    const parameters: ResolvedParameter[] = func.parameters.map((param) => {
      let resolvedRole: string | null = null;
      let resolvedName: string | null = null;
      let confidence = 0.5;
      let provenance: ResolvedParameter['provenance'] = 'type';
      let exposure: ResolvedParameter['exposure'] = 'agent_input';

      if (param.class === 'system') {
        resolvedName = param.moveType.includes('Clock') ? 'clock' : 'ctx';
        resolvedRole = param.moveType.includes('Clock') ? 'clock' : 'tx_context';
        confidence = 1.0;
        exposure = 'auto';
      } else if (param.class === 'pure' && matches[param.index] && processedTxCount > 0) {
        // Find matched event field with highest frequency
        const sortedMatches = Object.entries(matches[param.index]).sort((a, b) => b[1] - a[1]);
        if (sortedMatches.length > 0) {
          const [fieldName, frequency] = sortedMatches[0];
          resolvedName = fieldName;
          resolvedRole = fieldName;
          confidence = frequency / processedTxCount;
          provenance = 'event';
        }
      }

      if (!resolvedName) {
        resolvedName = param.class === 'coin' ? 'coin_inputs' : `arg${param.index}`;
      }

      return {
        ...param,
        name: resolvedName,
        role: resolvedRole,
        boundType: 'none',
        boundOf: null,
        exposure: exposure,
        default: param.class === 'system' && resolvedName === 'clock' ? '0x6' : null,
        confidence,
        provenance
      };
    });

    // 4. Analyze touched resources
    const coinTypes: string[] = [];
    const sharedObjects: string[] = [];

    for (const param of parameters) {
      if (param.class === 'coin' && param.moveType.includes('<')) {
        const coinType = param.moveType.match(/<(.*)>/)?.[1] || '';
        if (coinType) coinTypes.push(coinType);
      } else if (param.class === 'object') {
        sharedObjects.push(param.moveType.split('<')[0]);
      }
    }

    const minConfidence = parameters.reduce((min, p) => Math.min(min, p.confidence), 1.0);

    return {
      packageId,
      module: moduleName,
      functionName,
      packageVersion: '1',
      resolvedAt,
      typeParameters: func.typeParameters,
      parameters,
      emits: Array.from(emits),
      touches: {
        coinTypes,
        sharedObjects
      },
      safety: {
        spendingLimitDefault: coinTypes.length > 0 ? 1000000000 : null, // 1 SUI limit by default if coins are touched
        requiresConfirmation: minConfidence < 0.8
      }
    };
  }
}

export const resolverService = new ResolverService();
