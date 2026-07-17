#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { assertExecutionEnvelope } from '../../packages/rill-sdk/src/execution-envelope';

type Event = { eventType: string; json?: Record<string, unknown> | null };
type Identity = { walletId: string; balanceManagerId: string; clientOrderId: string };

export function extractHeroEvents(events: Event[], identity: Identity) {
  const spent = events.find((event) => event.eventType.endsWith('::agent_wallet::Spent') && event.json?.wallet === identity.walletId);
  const orderPlaced = events.find((event) =>
    event.eventType.endsWith('::order_info::OrderPlaced') &&
    event.json?.balance_manager_id === identity.balanceManagerId &&
    String(event.json?.client_order_id) === identity.clientOrderId,
  );
  if (!spent || !orderPlaced) throw new Error('Transaction does not contain matching Spent and OrderPlaced events.');
  return { spent, orderPlaced };
}

type RunSet = {
  network: 'testnet' | 'mainnet'; sender: string; walletId: string; agentCapId: string;
  balanceManagerId: string; tradeCapId: string;
  demoParams: { poolKey: string; clientOrderId: string };
};

const loadSet = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as RunSet;
const clientFor = (set: RunSet) => new SuiGrpcClient({
  baseUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
  network: set.network,
});

function walletFields(value: unknown): Record<string, unknown> {
  const json = (value as { object?: { json?: Record<string, unknown> | null } }).object?.json;
  if (!json) throw new Error('AgentWallet Move fields are unavailable.');
  return json;
}

async function wallet(setFile: string) {
  const set = loadSet(setFile);
  const object = await clientFor(set).getObject({ objectId: set.walletId, include: { json: true } });
  return { walletId: set.walletId, fields: walletFields(object), owner: object.object?.owner ?? null };
}

async function transaction(setFile: string, digest: string) {
  const set = loadSet(setFile);
  const client = clientFor(set);
  const result = await client.getTransaction({
    digest,
    include: { effects: true, events: true, objectTypes: true, transaction: true },
  });
  if (result.$kind === 'FailedTransaction') throw new Error(`Hero transaction ${digest} did not succeed.`);
  const tx = result.Transaction;
  if (tx.effects?.status.success !== true) throw new Error(`Hero transaction ${digest} did not succeed.`);
  const matched = extractHeroEvents((tx.events ?? []) as Event[], {
    walletId: set.walletId,
    balanceManagerId: set.balanceManagerId,
    clientOrderId: set.demoParams.clientOrderId,
  });
  const orderId = String(matched.orderPlaced.json?.order_id ?? '');
  if (!orderId) throw new Error('OrderPlaced event has no order_id.');
  const deepbook = new DeepBookClient({
    client: client as never,
    address: set.sender,
    network: set.network,
    balanceManagers: { HERO: { address: set.balanceManagerId, tradeCap: set.tradeCapId } },
  });
  const orderState = await deepbook.getOrderNormalized(set.demoParams.poolKey, orderId);
  return {
    digest,
    status: tx.effects.status,
    sender: set.sender,
    walletId: set.walletId,
    agentCapId: set.agentCapId,
    balanceManagerId: set.balanceManagerId,
    tradeCapId: set.tradeCapId,
    clientOrderId: set.demoParams.clientOrderId,
    spent: matched.spent,
    orderPlaced: matched.orderPlaced,
    orderState,
    objectChanges: tx.effects?.changedObjects ?? [],
  };
}

async function revoke(setFile: string, digest: string) {
  const set = loadSet(setFile);
  const client = clientFor(set);
  const [transactionResult, walletObject, tradeCap] = await Promise.all([
    client.getTransaction({ digest, include: { effects: true, events: true } }),
    client.getObject({ objectId: set.walletId, include: { json: true } }),
    client.getObject({ objectId: set.tradeCapId }).catch(() => null),
  ]);
  const transaction = transactionResult.$kind === 'Transaction' ? transactionResult.Transaction : transactionResult.FailedTransaction;
  const fields = walletFields(walletObject);
  if (fields.revoked !== true) throw new Error('AgentWallet is not revoked after owner transaction.');
  return {
    digest,
    status: transaction.effects?.status ?? null,
    walletId: set.walletId,
    walletRevoked: true,
    tradeCapId: set.tradeCapId,
    tradeCapAvailable: tradeCap !== null && tradeCap.object != null,
    events: transaction.events ?? [],
  };
}

async function devInspect(setFile: string, envelopeFile: string) {
  const set = loadSet(setFile);
  const parsed = JSON.parse(readFileSync(envelopeFile, 'utf8')) as { data?: unknown };
  const envelope = assertExecutionEnvelope(parsed.data ?? parsed);
  const tx = Transaction.from(Buffer.from(envelope.unsignedPtb, 'base64').toString('utf8'));
  const result = await clientFor(set).simulateTransaction({ transaction: tx, include: { effects: true } });
  if (result.$kind === 'Transaction') throw new Error('Known-revoked devInspect unexpectedly succeeded.');
  const status = result.FailedTransaction.effects?.status;
  const error = status?.error;
  const moveAbort = error?.$kind === 'MoveAbort' ? error.MoveAbort : null;
  if (status?.success !== false || moveAbort?.abortCode !== '2') {
    throw new Error(`Expected AgentWallet abort code 2, got: ${error?.message ?? 'unknown'}`);
  }
  return { submitted: false, expectedAbortCode: 2, status: status.success ? 'success' : 'failure', error: error?.message ?? '' };
}

async function main() {
  const [command, setFile, value] = process.argv.slice(2);
  if (!setFile) throw new Error('SET_FILE is required.');
  let output: unknown;
  if (command === 'wallet') output = await wallet(setFile);
  else if (command === 'transaction' && value) output = await transaction(setFile, value);
  else if (command === 'revoke' && value) output = await revoke(setFile, value);
  else if (command === 'dev-inspect' && value) output = await devInspect(setFile, value);
  else throw new Error('usage: hero-evidence wallet SET_FILE | transaction SET_FILE DIGEST | revoke SET_FILE DIGEST | dev-inspect SET_FILE ENVELOPE_FILE');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`hero-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
