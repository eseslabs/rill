import {
  DeepBookClient,
  mainnetPackageIds,
  testnetPackageIds,
} from '@mysten/deepbook-v3';
import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { config, suiClient } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { resolveDeepbookOrderConfig } from '../../core/node-config';
import type { AdapterCtx, FlowGraph, FlowNode, ProtocolAdapter } from './types';

const toMist = (sui: number) => BigInt(Math.round(sui * 1_000_000_000));

export const deepbookAdapter: ProtocolAdapter = {
  nodeType: 'deepbook_limit_order',

  rootSuiFunding(node: FlowNode, _flow: FlowGraph): bigint {
    return toMist(resolveDeepbookOrderConfig(node).config.depositSui);
  },

  async build(ctx: AdapterCtx): Promise<void> {
    const { tx, node, options, fundSuiCoin } = ctx;
    const order = resolveDeepbookOrderConfig(node).config;
    if (!options.agentWallet) {
      throw new ValidationError(`Node ${node.id}: DeepBook hero path requires an AgentWallet binding.`);
    }
    if (options.agentWallet.coinType !== SUI_COIN_TYPE) {
      throw new ValidationError(`Node ${node.id}: DeepBook hero path requires AgentWallet<SUI>.`);
    }
    if (!order.balanceManagerId) {
      throw new ValidationError(`Node ${node.id}: pre-provisioned BalanceManager is required.`);
    }
    if (!order.tradeCapId) {
      throw new ValidationError(`Node ${node.id}: delegated TradeCap is required.`);
    }
    if (!order.poolKey || order.price == null || order.quantity == null) {
      throw new ValidationError(`Node ${node.id}: poolKey, price, and quantity are required.`);
    }

    const spendAmountMist = toMist(order.depositSui);
    if (spendAmountMist <= 0n) {
      throw new ValidationError(`Node ${node.id}: depositSui must be positive.`);
    }
    const packageIds = config.network === 'testnet' ? testnetPackageIds : mainnetPackageIds;
    const walletCoin = fundSuiCoin(spendAmountMist);

    tx.moveCall({
      target: `${packageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
      typeArguments: [SUI_COIN_TYPE],
      arguments: [tx.object(order.balanceManagerId), walletCoin as never],
    });

    const deepbook = new DeepBookClient({
      client: suiClient as never,
      address: options.sender ?? '0x0',
      network: config.network,
      balanceManagers: {
        HERO: { address: order.balanceManagerId, tradeCap: order.tradeCapId },
      },
    });
    deepbook.deepBook.placeLimitOrder({
      poolKey: order.poolKey,
      balanceManagerKey: 'HERO',
      clientOrderId: order.clientOrderId,
      price: order.price,
      quantity: order.quantity,
      isBid: order.isBid,
      payWithDeep: order.payWithDeep,
    })(tx);
  },
};
