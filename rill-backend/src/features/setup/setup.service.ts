import {
  DeepBookClient,
  FLOAT_SCALAR,
  MAX_TIMESTAMP,
  mainnetCoins,
  mainnetPackageIds,
  mainnetPools,
  testnetCoins,
  testnetPackageIds,
  testnetPools,
} from '@mysten/deepbook-v3';
import { Transaction } from '@mysten/sui/transactions';
import { config, suiClient } from '../../core/config';
import { serializeUnsignedPtb } from '../compiler/ptb.util';
import type { PublishedSkill } from '../mcp/skills.store';

const SUI = '0x2::sui::SUI';
const PLACEHOLDER_BALANCE_MANAGER_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface PrepareSetupPlanResult {
  setupPtb: string;
  tradeCapPtb: string;
  runSetTemplate: Record<string, unknown>;
  walletPackageId: string;
  deepbookPackageId: string;
}

export function buildSetupTransaction(input: {
  walletPackageId: string;
  deepbookPackageId: string;
  agent: string;
  budgetMist: bigint;
  perTxMist: bigint;
  expiresAtMs: bigint;
}): Transaction {
  const tx = new Transaction();
  const [funds] = tx.splitCoins(tx.gas, [input.budgetMist]);
  tx.moveCall({
    target: `${input.walletPackageId}::agent_wallet::create_wallet`,
    typeArguments: [SUI],
    arguments: [
      funds,
      tx.pure.address(input.agent),
      tx.pure.u64(input.perTxMist),
      tx.pure.u64(input.expiresAtMs),
      tx.pure.vector('address', [input.deepbookPackageId]),
    ],
  });
  const manager = tx.moveCall({ target: `${input.deepbookPackageId}::balance_manager::new` });
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [`${input.deepbookPackageId}::balance_manager::BalanceManager`],
    arguments: [manager],
  });
  return tx;
}

export function buildMintTradeCapTransaction(deepbookPackageId: string, balanceManagerId: string, agent: string): Transaction {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: `${deepbookPackageId}::balance_manager::mint_trade_cap`,
    arguments: [tx.object(balanceManagerId)],
  });
  tx.transferObjects([cap], agent);
  return tx;
}

export function createdId(
  result: { effects?: { changedObjects?: readonly { objectId: string; idOperation: string }[] }; objectTypes?: Record<string, string> },
  suffix: string,
): string {
  const objectId = (result.effects?.changedObjects ?? [])
    .filter((item) => item.idOperation === 'Created')
    .find((item) => result.objectTypes?.[item.objectId]?.includes(suffix))?.objectId;
  if (!objectId) throw new Error(`Created ${suffix} object not found.`);
  return objectId;
}

export async function prepareSetupPlan(
  skill: PublishedSkill,
  sender: string,
  budgetMist: bigint,
  perTxMist: bigint,
  minimumRemainingMist: bigint,
  expiresAtMs: bigint,
  clientOrderId?: string,
): Promise<PrepareSetupPlanResult> {
  const network = config.network;
  const packageIds = network === 'mainnet' ? mainnetPackageIds : testnetPackageIds;
  const pools = network === 'mainnet' ? mainnetPools : testnetPools;
  const coins = network === 'mainnet' ? mainnetCoins : testnetCoins;
  const walletPackageId = config.agentWallet?.packageId;
  if (!walletPackageId) throw new Error('config.agentWallet.packageId is not configured.');
  const deepbookPackageId = packageIds.DEEPBOOK_PACKAGE_ID;

  const node = skill.flow.nodes.find((n) => n.type === 'deepbook_limit_order');
  const poolKey = (node?.config?.poolKey as string | undefined) ?? 'SUI_DBUSDC';
  const pool = pools[poolKey];
  if (!pool) throw new Error(`DeepBook pool ${poolKey} is unavailable on ${network}.`);

  const deepbook = new DeepBookClient({ client: suiClient as never, address: sender, network });
  const [book, midPrice] = await Promise.all([
    deepbook.poolBookParams(poolKey),
    deepbook.midPrice(poolKey),
  ]);

  const quantity = Math.max(book.minSize, book.lotSize);
  const price = Math.ceil((midPrice * 2) / book.tickSize) * book.tickSize;
  const depositSui = quantity * 1.1;
  const baseCoin = coins[pool.baseCoin];
  const quoteCoin = coins[pool.quoteCoin];
  if (!baseCoin || !quoteCoin) throw new Error(`DeepBook coin metadata is unavailable for ${poolKey}.`);

  const computedPriceMist = BigInt(Math.round((price * FLOAT_SCALAR * quoteCoin.scalar) / baseCoin.scalar));
  const computedQuantityMist = BigInt(Math.round(quantity * baseCoin.scalar));
  const spendAmountMist = BigInt(Math.ceil(depositSui * 1_000_000_000));
  if (spendAmountMist > perTxMist) {
    throw new Error(`Computed order spend ${spendAmountMist} exceeds per-tx cap ${perTxMist}.`);
  }
  if (budgetMist < perTxMist + minimumRemainingMist) {
    throw new Error('Wallet budget must cover one full per-tx spend plus the strategy minimum.');
  }

  const resolvedClientOrderId = clientOrderId ?? String(Date.now());
  const label = `${skill.id}_${Date.now()}`;

  const setupTx = buildSetupTransaction({
    walletPackageId,
    deepbookPackageId,
    agent: sender,
    budgetMist,
    perTxMist,
    expiresAtMs,
  });
  // ponytail: trade-cap PTB is templated with a placeholder BalanceManager ID; the local signer
  // fills it with the actual ID created by the setup PTB before signing.
  const tradeCapTx = buildMintTradeCapTransaction(deepbookPackageId, PLACEHOLDER_BALANCE_MANAGER_ID, sender);

  const [setupPtb, tradeCapPtb] = await Promise.all([
    serializeUnsignedPtb(setupTx),
    serializeUnsignedPtb(tradeCapTx),
  ]);

  const allowedTargets = [
    `${walletPackageId}::agent_wallet::spend`,
    `${deepbookPackageId}::balance_manager::deposit`,
    `${deepbookPackageId}::balance_manager::generate_proof_as_trader`,
    `${deepbookPackageId}::pool::place_limit_order`,
  ];

  const runSetTemplate = {
    version: '1',
    label,
    actionId: skill.id,
    network,
    sender,
    walletPackageId,
    walletId: '',
    agentCapId: '',
    balanceManagerId: '',
    tradeCapId: '',
    poolId: pool.address,
    allowedTargets,
    requiredGuards: [],
    maxAmountMist: perTxMist.toString(),
    minimumRemainingMist: minimumRemainingMist.toString(),
    demoParams: {
      poolKey,
      price,
      quantity,
      isBid: false,
      payWithDeep: false,
      clientOrderId: resolvedClientOrderId,
      depositSui,
    },
    onChainOrder: {
      clientOrderId: resolvedClientOrderId,
      orderType: '0',
      selfMatchingOption: '0',
      price: computedPriceMist.toString(),
      quantity: computedQuantityMist.toString(),
      isBid: false,
      payWithDeep: false,
      expiration: MAX_TIMESTAMP.toString(),
    },
  };

  return { setupPtb, tradeCapPtb, runSetTemplate, walletPackageId, deepbookPackageId };
}
