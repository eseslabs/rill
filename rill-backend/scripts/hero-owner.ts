#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildMintTradeCapTransaction,
  buildSetupTransaction,
  createdId,
} from '../src/features/setup/setup.service';

const SUI = '0x2::sui::SUI';

export function buildRevokeTransaction(input: {
  walletPackageId: string; deepbookPackageId: string; walletId: string;
  balanceManagerId: string; tradeCapId: string; owner: string;
}): Transaction {
  const tx = new Transaction();
  const reclaimed = tx.moveCall({
    target: `${input.walletPackageId}::agent_wallet::revoke`,
    typeArguments: [SUI],
    arguments: [tx.object(input.walletId)],
  });
  tx.transferObjects([reclaimed], input.owner);
  tx.moveCall({
    target: `${input.deepbookPackageId}::balance_manager::revoke_trade_cap`,
    arguments: [tx.object(input.balanceManagerId), tx.pure.id(input.tradeCapId)],
  });
  return tx;
}

type RunSet = {
  version: '1'; label: string; actionId: string; network: 'testnet' | 'mainnet'; sender: string;
  walletPackageId: string; walletId: string; agentCapId: string; balanceManagerId: string; tradeCapId: string;
  poolId: string; allowedTargets: string[]; requiredGuards: string[]; maxAmountMist: string;
  minimumRemainingMist: string; demoParams: { poolKey: string; price: number; quantity: number; isBid: false; payWithDeep: false; clientOrderId: string; depositSui: number };
  onChainOrder: { clientOrderId: string; orderType: '0'; selfMatchingOption: '0'; price: string; quantity: string; isBid: false; payWithDeep: false; expiration: string };
};

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

async function execute(client: SuiGrpcClient, keypair: Ed25519Keypair, tx: Transaction) {
  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    include: { effects: true, events: true, objectTypes: true },
  });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(result.FailedTransaction.effects?.status.error?.message ?? 'Owner transaction failed.');
  }
  await client.waitForTransaction({ digest: result.Transaction.digest, include: { effects: true } });
  if (result.Transaction.effects?.status.success !== true) {
    throw new Error(result.Transaction.effects?.status.error?.message ?? 'Owner transaction failed.');
  }
  return result.Transaction;
}

const setPath = (label: string) => `.rill/demo/sets/${label}.json`;
const readSet = (label: string) => JSON.parse(readFileSync(setPath(label), 'utf8')) as RunSet;

function moveFields(value: unknown): Record<string, unknown> {
  const json = (value as { object?: { json?: Record<string, unknown> | null } }).object?.json;
  if (!json) throw new Error('AgentWallet Move fields are unavailable.');
  return json;
}

function moveU64(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as { value?: unknown; fields?: { value?: unknown } };
    const nested = record.value ?? record.fields?.value;
    if (typeof nested === 'string' || typeof nested === 'number') return String(nested);
  }
  throw new Error(`AgentWallet ${name} is not a u64 field.`);
}

function networkConfig() {
  const network = process.env.SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const packageIds = network === 'mainnet' ? mainnetPackageIds : testnetPackageIds;
  const pools = network === 'mainnet' ? mainnetPools : testnetPools;
  const coins = network === 'mainnet' ? mainnetCoins : testnetCoins;
  const poolKey = process.env.RILL_POOL_KEY ?? (network === 'mainnet' ? 'SUI_USDC' : 'SUI_DBUSDC');
  const pool = pools[poolKey];
  if (!pool) throw new Error(`DeepBook pool ${poolKey} is unavailable on ${network}.`);
  return { network, packageIds, coins, poolKey, pool } as const;
}

async function setup(label: string, clientOrderId: string): Promise<void> {
  if (!/^\d+$/.test(clientOrderId)) throw new Error('CLIENT_ORDER_ID must be a decimal u64 string.');
  const { network, packageIds, coins, poolKey, pool } = networkConfig();
  const walletPackageId = required('AGENT_WALLET_PACKAGE_ID');
  const actionId = required('RILL_ACTION_ID');
  const agent = required('RILL_AGENT_ADDRESS');
  const budgetMist = BigInt(required('RILL_BUDGET_MIST'));
  const perTxMist = BigInt(required('RILL_PER_TX_MIST'));
  const minimumRemainingMist = BigInt(required('RILL_MINIMUM_REMAINING_MIST'));
  const ownerKeypair = Ed25519Keypair.fromSecretKey(required('RILL_OWNER_PRIVATE_KEY'));
  const owner = ownerKeypair.getPublicKey().toSuiAddress();
  const client = new SuiGrpcClient({
    baseUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
    network,
  });
  const deepbook = new DeepBookClient({ client: client as never, address: owner, network });
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
  const onChainOrder = {
    clientOrderId,
    orderType: '0' as const,
    selfMatchingOption: '0' as const,
    price: BigInt(Math.round((price * FLOAT_SCALAR * quoteCoin.scalar) / baseCoin.scalar)).toString(),
    quantity: BigInt(Math.round(quantity * baseCoin.scalar)).toString(),
    isBid: false as const,
    payWithDeep: false as const,
    expiration: MAX_TIMESTAMP.toString(),
  };
  const spendAmountMist = BigInt(Math.ceil(depositSui * 1_000_000_000));
  if (spendAmountMist > perTxMist) throw new Error(`Computed order spend ${spendAmountMist} exceeds per-tx cap ${perTxMist}.`);
  if (budgetMist < perTxMist + minimumRemainingMist) {
    throw new Error('Wallet budget must cover one full per-tx spend plus the strategy minimum.');
  }

  const setupResult = await execute(client, ownerKeypair, buildSetupTransaction({
    walletPackageId,
    deepbookPackageId: packageIds.DEEPBOOK_PACKAGE_ID,
    agent,
    budgetMist,
    perTxMist,
    expiresAtMs: BigInt(Date.now() + 24 * 60 * 60 * 1000),
  }));
  const walletId = createdId(setupResult, '::agent_wallet::AgentWallet');
  const agentCapId = createdId(setupResult, '::agent_wallet::AgentCap');
  const balanceManagerId = createdId(setupResult, '::balance_manager::BalanceManager');
  const capResult = await execute(
    client,
    ownerKeypair,
    buildMintTradeCapTransaction(packageIds.DEEPBOOK_PACKAGE_ID, balanceManagerId, agent),
  );
  const tradeCapId = createdId(capResult, '::balance_manager::TradeCap');
  const allowedTargets = [
    `${walletPackageId}::agent_wallet::spend`,
    `${packageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
    `${packageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::generate_proof_as_trader`,
    `${packageIds.DEEPBOOK_PACKAGE_ID}::pool::place_limit_order`,
  ];
  const set: RunSet = {
    version: '1',
    label,
    actionId,
    network,
    sender: agent,
    walletPackageId,
    walletId,
    agentCapId,
    balanceManagerId,
    tradeCapId,
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
      clientOrderId,
      depositSui,
    },
    onChainOrder,
  };
  const path = setPath(label);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    setupDigest: setupResult.digest,
    tradeCapDigest: capResult.digest,
    setPath: path,
    ...set,
  }, null, 2)}\n`);
}

async function status(label: string): Promise<void> {
  const set = readSet(label);
  const client = new SuiGrpcClient({
    baseUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
    network: set.network,
  });
  const wallet = await client.getObject({ objectId: set.walletId, include: { json: true } });
  const fields = moveFields(wallet);
  const remainingMist = moveU64(fields, 'budget');
  const revoked = fields.revoked === true;
  const expiresAtMs = moveU64(fields, 'expires_at_ms');
  process.stdout.write(`${JSON.stringify({
    label,
    sender: set.sender,
    walletId: set.walletId,
    agentCapId: set.agentCapId,
    balanceManagerId: set.balanceManagerId,
    tradeCapId: set.tradeCapId,
    remainingMist,
    spentMist: moveU64(fields, 'spent'),
    perTxMaxMist: moveU64(fields, 'per_tx_max'),
    expiresAtMs,
    revoked,
    minimumRemainingMist: set.minimumRemainingMist,
    strategyEligible:
      !revoked &&
      Date.now() < Number(expiresAtMs) &&
      BigInt(remainingMist) >= BigInt(set.minimumRemainingMist),
  }, null, 2)}\n`);
}

async function revoke(label: string): Promise<void> {
  const set = readSet(label);
  const ownerKeypair = Ed25519Keypair.fromSecretKey(required('RILL_OWNER_PRIVATE_KEY'));
  const owner = ownerKeypair.getPublicKey().toSuiAddress();
  const client = new SuiGrpcClient({
    baseUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
    network: set.network,
  });
  const result = await execute(client, ownerKeypair, buildRevokeTransaction({
    walletPackageId: set.walletPackageId,
    deepbookPackageId:
      set.network === 'mainnet' ? mainnetPackageIds.DEEPBOOK_PACKAGE_ID : testnetPackageIds.DEEPBOOK_PACKAGE_ID,
    walletId: set.walletId,
    balanceManagerId: set.balanceManagerId,
    tradeCapId: set.tradeCapId,
    owner,
  }));
  process.stdout.write(`${JSON.stringify({ label, digest: result.digest, walletId: set.walletId, tradeCapId: set.tradeCapId }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command, label, clientOrderId] = process.argv.slice(2);
  if (!label || !['setup', 'status', 'revoke'].includes(command)) {
    throw new Error('usage: hero-owner setup LABEL CLIENT_ORDER_ID | status LABEL | revoke LABEL');
  }
  if (command === 'setup') {
    if (!clientOrderId) throw new Error('CLIENT_ORDER_ID is required for setup.');
    return setup(label, clientOrderId);
  }
  if (command === 'status') return status(label);
  return revoke(label);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`hero-owner: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
