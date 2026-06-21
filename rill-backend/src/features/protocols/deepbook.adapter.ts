import { DeepBookClient } from '@mysten/deepbook-v3';
import { config, suiClient } from '../../core/config';
import { resolveDeepbookOrderConfig } from '../../core/node-config';
import type { AdapterCtx, ProtocolAdapter } from './types';

/**
 * DeepBook v3 limit order. Uses the official SDK builders (`(tx) => void`) composed into the same PTB
 * — PTB-safe, no signing in the backend. The BalanceManager is pre-funded during onboarding, so the
 * order draws from its internal balance (no root SUI funding here). Owner-proof requires the tx sender
 * to equal the BalanceManager owner; for delegated agents, pass `tradeCapId` (trade, not withdraw).
 */
export const deepbookAdapter: ProtocolAdapter = {
  nodeType: 'deepbook_limit_order',

  rootSuiFunding(): bigint {
    return 0n; // BalanceManager is funded via onboarding, not from the flow's root coin
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, node, options, warnings } = ctx;
    const { config: order, warnings: cfgWarnings } = resolveDeepbookOrderConfig(node);
    warnings.push(...cfgWarnings);

    const db = new DeepBookClient({
      // SuiJsonRpcClient implements the core read API the SDK needs (read-only here; we only build).
      client: suiClient as never,
      address: options.sender ?? '0x0',
      network: config.network,
      balanceManagers: {
        NODE: { address: order.balanceManagerId, tradeCap: order.tradeCapId },
      },
    });

    // Self-funding: deposit SUI into the BalanceManager from the sender's coins before the order, so the
    // order doesn't need a separately pre-funded BM. (Future: route this through agent_wallet::spend.)
    if (order.depositSui > 0) {
      db.balanceManager.depositIntoManager('NODE', 'SUI', order.depositSui)(tx);
    }

    // Appends place_limit_order (+ the trade proof) to our PTB. The agent signs it later (keyless backend).
    db.deepBook.placeLimitOrder({
      poolKey: order.poolKey,
      balanceManagerKey: 'NODE',
      clientOrderId: order.clientOrderId,
      price: order.price,
      quantity: order.quantity,
      isBid: order.isBid,
      payWithDeep: order.payWithDeep,
    })(tx);

    return Promise.resolve();
  },
};
