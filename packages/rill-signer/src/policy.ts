import { readFileSync } from 'node:fs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { assertExecutionEnvelope, digestUnsignedPtb } from '../../rill-sdk/src/execution-envelope';
import type { ExecutionEnvelope, RillNetwork } from '../../rill-sdk/src/types';

export interface LocalSignerPolicy {
  version: '1';
  actionId: string;
  network: RillNetwork;
  sender: string;
  walletPackageId: string;
  walletId: string;
  agentCapId: string;
  balanceManagerId: string;
  tradeCapId: string;
  poolId: string;
  allowedTargets: string[];
  requiredGuards: string[];
  maxAmountMist: string;
  minimumRemainingMist: string;
  demoParams: {
    poolKey: string;
    price: number;
    quantity: number;
    isBid: boolean;
    payWithDeep: boolean;
    clientOrderId: string;
    depositSui: number;
  };
  onChainOrder: {
    clientOrderId: string;
    orderType: string;
    selfMatchingOption: string;
    price: string;
    quantity: string;
    isBid: boolean;
    payWithDeep: boolean;
    expiration: string;
  };
}

export interface ValidatedEnvelope {
  transaction: Transaction;
  targets: string[];
  objectIds: string[];
  spendAmountMist: bigint;
}

const normalized = (value: string) => normalizeSuiAddress(value);

function expectNormalizedMatch(actual: string, expected: string, message: string): void {
  if (normalized(actual) !== normalized(expected)) {
    throw new Error(message);
  }
}

function normalizeTarget(target: string): string {
  const [packageId, module, fn, extra] = target.split('::');
  if (!packageId || !module || !fn || extra) throw new Error(`Invalid Move target ${target}.`);
  return `${normalized(packageId)}::${module}::${fn}`;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function decimalU64(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a decimal u64 string.`);
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error(`${label} exceeds u64.`);
  return parsed;
}

export function loadPolicy(path = process.env.RILL_SIGNER_POLICY_PATH): LocalSignerPolicy {
  if (!path) throw new Error('RILL_SIGNER_POLICY_PATH is required.');
  const policy = JSON.parse(readFileSync(path, 'utf8')) as LocalSignerPolicy;
  if (policy.version !== '1') throw new Error('Local signer policy version must be 1.');
  return policy;
}

export function readMoveU64(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as { value?: unknown; fields?: { value?: unknown } };
    const nested = record.value ?? record.fields?.value;
    if (typeof nested === 'string' || typeof nested === 'number') return String(nested);
  }
  throw new Error(`AgentWallet ${name} is not a u64 field.`);
}

function readMoveId(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { id?: unknown; bytes?: unknown; fields?: { id?: unknown; bytes?: unknown } };
    const nested = record.id ?? record.bytes ?? record.fields?.id ?? record.fields?.bytes;
    if (typeof nested === 'string') return nested;
  }
  throw new Error(`${name} is not an object ID field.`);
}

function inspect(transaction: Transaction, policy: LocalSignerPolicy) {
  const data = transaction.getData();
  const targetOf = (command: (typeof data.commands)[number]) => command.$kind === 'MoveCall'
    ? `${normalized(command.MoveCall.package)}::${command.MoveCall.module}::${command.MoveCall.function}`
    : '';
  const targets = data.commands.flatMap((command) => {
    const target = targetOf(command);
    return target ? [target] : [];
  });
  const uniqueTargets = [...new Set(targets)];
  const objectIdFromInput = (input: (typeof data.inputs)[number]): string | undefined => {
    if (input.$kind === 'UnresolvedObject') return normalized(input.UnresolvedObject.objectId);
    if (input.$kind !== 'Object') return undefined;
    if (input.Object.$kind === 'SharedObject') return normalized(input.Object.SharedObject.objectId);
    if (input.Object.$kind === 'ImmOrOwnedObject') return normalized(input.Object.ImmOrOwnedObject.objectId);
    return normalized(input.Object.Receiving.objectId);
  };
  const objectIds = [...new Set(data.inputs.flatMap((input) => {
    const objectId = objectIdFromInput(input);
    return objectId ? [objectId] : [];
  }))];
  const inputAt = (argument: unknown, label: string) => {
    const value = argument as { $kind?: string; Input?: number };
    if (value.$kind !== 'Input' || value.Input == null) throw new Error(`${label} is not an input.`);
    const input = data.inputs[value.Input];
    if (!input) throw new Error(`${label} input is missing.`);
    return input;
  };
  const objectArgument = (argument: unknown, label: string) => {
    const objectId = objectIdFromInput(inputAt(argument, label));
    if (!objectId) throw new Error(`${label} is not an object input.`);
    return objectId;
  };
  const pureBytes = (argument: unknown, label: string) => {
    const input = inputAt(argument, label);
    if (input.$kind !== 'Pure') throw new Error(`${label} is not pure.`);
    return Buffer.from(input.Pure.bytes, 'base64');
  };
  const u64 = (argument: unknown, label: string) => {
    const bytes = pureBytes(argument, label);
    if (bytes.length !== 8) throw new Error(`${label} is not a u64.`);
    return bytes.readBigUInt64LE();
  };
  const byte = (argument: unknown, label: string) => {
    const bytes = pureBytes(argument, label);
    if (bytes.length !== 1) throw new Error(`${label} is not a byte.`);
    return bytes[0];
  };
  const exactArity = (arguments_: readonly unknown[], expected: number, label: string) => {
    if (arguments_.length !== expected) {
      throw new Error(`${label} must have exactly ${expected} arguments.`);
    }
  };

  const walletTarget = normalizeTarget(`${policy.walletPackageId}::agent_wallet::spend`);
  const spendIndex = data.commands.findIndex((command) => targetOf(command) === walletTarget);
  const spend = data.commands[spendIndex];
  if (!spend || spend.$kind !== 'MoveCall') throw new Error('PTB is missing required wallet spend target.');
  exactArity(spend.MoveCall.arguments, 4, 'PTB wallet spend');
  expectNormalizedMatch(
    objectArgument(spend.MoveCall.arguments[3], 'wallet spend clock'),
    '0x6',
    'PTB wallet spend clock mismatch.',
  );
  expectNormalizedMatch(
    objectArgument(spend.MoveCall.arguments[0], 'wallet spend wallet'),
    policy.walletId,
    'PTB wallet spend walletId mismatch.',
  );
  expectNormalizedMatch(
    objectArgument(spend.MoveCall.arguments[1], 'wallet spend AgentCap'),
    policy.agentCapId,
    'PTB wallet spend agentCapId mismatch.',
  );
  const spendAmountMist = u64(spend.MoveCall.arguments[2], 'wallet spend amount');

  const depositIndex = data.commands.findIndex((command) => targetOf(command).endsWith('::balance_manager::deposit'));
  const deposit = data.commands[depositIndex];
  if (!deposit || deposit.$kind !== 'MoveCall' || depositIndex <= spendIndex) {
    throw new Error('PTB is missing ordered DeepBook deposit.');
  }
  exactArity(deposit.MoveCall.arguments, 2, 'PTB DeepBook deposit');
  expectNormalizedMatch(
    objectArgument(deposit.MoveCall.arguments[0], 'DeepBook deposit BalanceManager'),
    policy.balanceManagerId,
    'PTB DeepBook deposit BalanceManager mismatch.',
  );
  const depositedCoin = deposit.MoveCall.arguments[1];
  if (depositedCoin.$kind !== 'NestedResult' || depositedCoin.NestedResult[1] !== 0) {
    throw new Error('DeepBook deposit is not wallet-funded.');
  }
  const splitIndex = depositedCoin.NestedResult[0];
  const split = data.commands[splitIndex];
  if (
    !split ||
    split.$kind !== 'SplitCoins' ||
    split.SplitCoins.coin.$kind !== 'Result' ||
    split.SplitCoins.coin.Result !== spendIndex ||
    split.SplitCoins.amounts.length !== 1
  ) {
    throw new Error('DeepBook deposit is not wallet-funded.');
  }
  const depositAmountMist = u64(split.SplitCoins.amounts[0], 'DeepBook deposit amount');
  if (depositAmountMist !== spendAmountMist) {
    throw new Error('DeepBook deposit does not consume the full wallet spend.');
  }

  const proofIndex = data.commands.findIndex((command) =>
    targetOf(command).endsWith('::balance_manager::generate_proof_as_trader')
  );
  const proof = data.commands[proofIndex];
  if (!proof || proof.$kind !== 'MoveCall' || proofIndex <= depositIndex) {
    throw new Error('PTB is missing ordered DeepBook trader proof.');
  }
  exactArity(proof.MoveCall.arguments, 2, 'PTB DeepBook trader proof');
  expectNormalizedMatch(
    objectArgument(proof.MoveCall.arguments[0], 'DeepBook proof BalanceManager'),
    policy.balanceManagerId,
    'PTB DeepBook proof BalanceManager mismatch.',
  );
  expectNormalizedMatch(
    objectArgument(proof.MoveCall.arguments[1], 'DeepBook proof TradeCap'),
    policy.tradeCapId,
    'PTB DeepBook proof TradeCap mismatch.',
  );

  const orderIndex = data.commands.findIndex((command) => targetOf(command).endsWith('::pool::place_limit_order'));
  const order = data.commands[orderIndex];
  if (!order || order.$kind !== 'MoveCall' || orderIndex <= proofIndex) {
    throw new Error('PTB is missing ordered DeepBook limit order.');
  }
  exactArity(order.MoveCall.arguments, 12, 'PTB DeepBook order');
  expectNormalizedMatch(
    objectArgument(order.MoveCall.arguments[11], 'DeepBook order clock'),
    '0x6',
    'PTB DeepBook order clock mismatch.',
  );
  expectNormalizedMatch(
    objectArgument(order.MoveCall.arguments[0], 'DeepBook order pool'),
    policy.poolId,
    'PTB DeepBook order poolId mismatch.',
  );
  expectNormalizedMatch(
    objectArgument(order.MoveCall.arguments[1], 'DeepBook order BalanceManager'),
    policy.balanceManagerId,
    'PTB DeepBook order BalanceManager mismatch.',
  );
  const proofArgument = order.MoveCall.arguments[2];
  if (proofArgument.$kind !== 'Result' || proofArgument.Result !== proofIndex) {
    throw new Error('PTB DeepBook order is not authorized by the required TradeCap proof.');
  }
  const isBid = byte(order.MoveCall.arguments[8], 'DeepBook order isBid');
  const payWithDeep = byte(order.MoveCall.arguments[9], 'DeepBook order payWithDeep');
  if (isBid > 1 || payWithDeep > 1) throw new Error('PTB DeepBook order contains an invalid boolean.');
  const onChainOrder = {
    clientOrderId: u64(order.MoveCall.arguments[3], 'DeepBook order clientOrderId').toString(),
    orderType: String(byte(order.MoveCall.arguments[4], 'DeepBook order orderType')),
    selfMatchingOption: String(byte(order.MoveCall.arguments[5], 'DeepBook order selfMatchingOption')),
    price: u64(order.MoveCall.arguments[6], 'DeepBook order price').toString(),
    quantity: u64(order.MoveCall.arguments[7], 'DeepBook order quantity').toString(),
    isBid: isBid === 1,
    payWithDeep: payWithDeep === 1,
    expiration: u64(order.MoveCall.arguments[10], 'DeepBook order expiration').toString(),
  };

  const allowedCommands = data.commands.every((command) =>
    command.$kind === 'MoveCall' || command.$kind === 'SplitCoins' || command.$kind === 'MergeCoins'
  );
  const splitCount = data.commands.filter((command) => command.$kind === 'SplitCoins').length;
  const mergeIndex = data.commands.findIndex((command) => command.$kind === 'MergeCoins');
  const mergeCount = data.commands.filter((command) => command.$kind === 'MergeCoins').length;
  if (!allowedCommands || splitCount !== 1 || mergeCount !== 1) {
    throw new Error('PTB command manifest contains an unsupported or duplicate funding command.');
  }
  const merge = data.commands[mergeIndex];
  const cleanupSource = merge?.$kind === 'MergeCoins' ? merge.MergeCoins.sources[0] : undefined;
  if (
    merge?.$kind !== 'MergeCoins' ||
    mergeIndex <= orderIndex ||
    mergeIndex !== data.commands.length - 1 ||
    merge.MergeCoins.destination.$kind !== 'GasCoin' ||
    merge.MergeCoins.sources.length !== 1 ||
    cleanupSource?.$kind !== 'Result' ||
    cleanupSource.Result !== spendIndex
  ) {
    throw new Error('PTB wallet funding cleanup must be the final command merging only the wallet spend remainder into gas.');
  }
  return { data, targets: uniqueTargets, callTargets: targets, objectIds, spendAmountMist, onChainOrder };
}

export async function validateExecutionEnvelope(
  value: unknown,
  signerAddress: string,
  signerNetwork: RillNetwork,
  policy: LocalSignerPolicy,
  now = Date.now(),
): Promise<ValidatedEnvelope> {
  const envelope = assertExecutionEnvelope(value);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error('ExecutionEnvelope expiresAt is invalid.');
  if (expiresAt <= now) throw new Error('ExecutionEnvelope expired.');
  if (expiresAt > now + 5 * 60_000) {
    throw new Error('ExecutionEnvelope exceeds the five-minute maximum TTL.');
  }
  if (envelope.network !== signerNetwork || envelope.network !== policy.network) {
    throw new Error('ExecutionEnvelope network mismatch.');
  }
  if (
    normalized(envelope.sender) !== normalized(signerAddress) ||
    normalized(envelope.sender) !== normalized(policy.sender)
  ) {
    throw new Error('ExecutionEnvelope sender mismatch.');
  }
  if (envelope.actionId !== policy.actionId) throw new Error('ExecutionEnvelope actionId mismatch.');

  const identityPairs: Array<[string, string, string]> = [
    ['walletPackageId', envelope.walletPackageId, policy.walletPackageId],
    ['walletId', envelope.walletId, policy.walletId],
    ['agentCapId', envelope.agentCapId, policy.agentCapId],
    ['balanceManagerId', envelope.balanceManagerId, policy.balanceManagerId],
    ['tradeCapId', envelope.tradeCapId, policy.tradeCapId],
  ];
  for (const [name, actual, expected] of identityPairs) {
    if (normalized(actual) !== normalized(expected)) {
      throw new Error(`ExecutionEnvelope ${name} mismatch.`);
    }
  }
  if (normalized(envelope.resolvedParams.poolId) !== normalized(policy.poolId)) {
    throw new Error('ExecutionEnvelope poolId mismatch.');
  }
  for (const [name, expected] of Object.entries(policy.demoParams)) {
    const actual = envelope.resolvedParams[name as keyof ExecutionEnvelope['resolvedParams']];
    if (typeof expected === 'number' && typeof actual === 'number') {
      if (Math.abs(actual - expected) > 1e-9) {
        throw new Error(`ExecutionEnvelope resolved ${name} mismatch.`);
      }
      continue;
    }
    if (String(actual) !== String(expected)) {
      throw new Error(`ExecutionEnvelope resolved ${name} mismatch.`);
    }
  }
  if (!envelope.simulation.ok || envelope.simulation.verification !== 'verified') {
    throw new Error('ExecutionEnvelope simulation is not a verified success.');
  }
  const requiredGuards = policy.requiredGuards.map(normalizeTarget);
  if (!sameValues(envelope.requiredGuards.map(normalizeTarget), requiredGuards)) {
    throw new Error('ExecutionEnvelope required guard policy mismatch.');
  }
  if (await digestUnsignedPtb(envelope.unsignedPtb) !== envelope.actionDigest) {
    throw new Error('ExecutionEnvelope actionDigest mismatch.');
  }

  let transaction: Transaction;
  try {
    transaction = Transaction.from(Buffer.from(envelope.unsignedPtb, 'base64').toString('utf8'));
  } catch {
    throw new Error('ExecutionEnvelope unsignedPtb is invalid.');
  }
  const inspected = inspect(transaction, policy);
  if (typeof inspected.data.sender !== 'string' || normalized(inspected.data.sender) !== normalized(envelope.sender)) {
    throw new Error('PTB sender mismatch.');
  }
  const envelopeTargets = envelope.allowedTargets.map(normalizeTarget);
  const policyTargets = policy.allowedTargets.map(normalizeTarget);
  if (!sameValues(inspected.targets, envelopeTargets)) {
    throw new Error('PTB target manifest mismatch.');
  }
  const policyTargetSet = new Set(policyTargets);
  const offScope = inspected.targets.find((target) => !policyTargetSet.has(target));
  if (offScope) throw new Error(`PTB contains off-scope target ${offScope}.`);
  if (
    inspected.callTargets.length !== policyTargets.length ||
    !inspected.callTargets.every((target, index) => target === policyTargets[index])
  ) {
    throw new Error('PTB target sequence differs from the local policy.');
  }
  for (const guard of requiredGuards) {
    if (!inspected.targets.includes(guard)) throw new Error(`PTB is missing required guard ${guard}.`);
  }
  const envelopeObjects = envelope.requiredObjectIds.map(normalized);
  if (!sameValues(inspected.objectIds, envelopeObjects)) {
    throw new Error('PTB requiredObjectIds manifest mismatch.');
  }
  const policyObjectIds = [
    policy.walletId,
    policy.agentCapId,
    policy.balanceManagerId,
    policy.tradeCapId,
    policy.poolId,
    '0x6',
  ].map(normalized);
  if (!sameValues(inspected.objectIds, policyObjectIds)) {
    throw new Error('PTB object policy must contain exactly the fixed hero objects and Sui clock.');
  }
  const resolvedSpend = decimalU64(
    envelope.resolvedParams.spendAmountMist,
    'ExecutionEnvelope resolved spendAmountMist',
  );
  if (inspected.spendAmountMist !== resolvedSpend) {
    throw new Error('PTB amount differs from resolvedParams.');
  }
  if (inspected.spendAmountMist > decimalU64(policy.maxAmountMist, 'Local policy maxAmountMist')) {
    throw new Error('PTB amount exceeds maxAmountMist.');
  }
  const expectedSpendAmountMist = BigInt(Math.round(policy.demoParams.depositSui * 1_000_000_000));
  if (inspected.spendAmountMist !== expectedSpendAmountMist) {
    throw new Error('PTB amount differs from demo depositSui policy.');
  }
  for (const [name, expected] of Object.entries(policy.onChainOrder)) {
    if (inspected.onChainOrder[name as keyof typeof inspected.onChainOrder] !== expected) {
      throw new Error(`PTB DeepBook order manifest mismatch (${name}).`);
    }
  }
  return {
    transaction,
    targets: inspected.targets,
    objectIds: inspected.objectIds,
    spendAmountMist: inspected.spendAmountMist,
  };
}

export async function assertCapabilitiesActive(
  client: Pick<SuiGrpcClient, 'getObject'>,
  policy: LocalSignerPolicy,
  spendAmountMist: bigint,
): Promise<void> {
  const wallet = await client.getObject({
    objectId: policy.walletId,
    include: { json: true, owner: true },
  });
  if (!wallet.object?.json || wallet.object.owner?.$kind !== 'Shared') {
    throw new Error('AgentWallet is unavailable or not a live shared object.');
  }
  const fields = wallet.object.json;
  if (fields.revoked === true) throw new Error('AgentWallet is revoked.');
  if (typeof fields.agent !== 'string') {
    throw new Error('AgentWallet agent mismatch.');
  }
  if (normalized(fields.agent) !== normalized(policy.sender)) {
    throw new Error('AgentWallet agent mismatch.');
  }
  const remainingMist = decimalU64(readMoveU64(fields, 'budget'), 'AgentWallet budget');
  if (remainingMist < spendAmountMist) throw new Error('AgentWallet balance cannot cover this action.');
  if (
    remainingMist - spendAmountMist <
    decimalU64(policy.minimumRemainingMist, 'Local policy minimumRemainingMist')
  ) {
    throw new Error('AgentWallet balance would fall below minimumRemainingMist after this action.');
  }

  const capabilities = [
    ['AgentCap', policy.agentCapId, 'wallet', policy.walletId],
    ['TradeCap', policy.tradeCapId, 'balance_manager_id', policy.balanceManagerId],
  ] as const;
  for (const [label, objectId, bindingField, expectedBinding] of capabilities) {
    const object = await client.getObject({
      objectId,
      include: { json: true, owner: true },
    });
    if (!object.object) throw new Error(`${label} is revoked or unavailable.`);
    const owner = object.object.owner;
    if (
      owner?.$kind !== 'AddressOwner' ||
      normalized(owner.AddressOwner) !== normalized(policy.sender)
    ) {
      throw new Error(`${label} is not held by the local signer.`);
    }
    const capabilityFields = object.object.json;
    if (!capabilityFields) throw new Error(`${label} state is unavailable.`);
    if (normalized(readMoveId(capabilityFields, bindingField)) !== normalized(expectedBinding)) {
      const bindingName = label === 'AgentCap' ? 'wallet' : 'BalanceManager';
      throw new Error(`${label} ${bindingName} mismatch.`);
    }
  }
}

// ── inspectOnboarding ──────────────────────────────────────────────────────────────────────────
//
// A NEW, INDEPENDENT structural inspector for backend-supplied onboarding PTBs (create_run_set's
// setupPtb / tradeCapPtb in mcp.ts). This shares ZERO code with inspect() above by design: inspect()
// is a hardcoded validator for the one fixed DeepBook envelope sequence that validateExecutionEnvelope
// (R9-R11) depends on, and must stay stable and untouched. Onboarding PTBs have a different, much
// simpler shape (wallet creation, balance-manager creation, trade-cap mint), so this walks the command
// list from scratch in the same style — rather than generalizing or reusing inspect()'s internals —
// so neither validator can destabilize the other.
//
// R8: the signer must never sign backend-supplied bytes without structural policy inspection,
// including onboarding. This function is the onboarding half of that boundary: it allows only
// MoveCalls to an explicit target allowlist, SplitCoins/MergeCoins bookkeeping, and TransferObjects to
// an explicit recipient allowlist (sender/agent), and it enforces a hard ceiling on the total value any
// SplitCoins command in the PTB may carve off. Any other shape is rejected.

export interface OnboardingAllowlist {
  /** Exact Move call targets (`package::module::function`) permitted anywhere in the PTB. */
  allowedTargets: readonly string[];
  /** Addresses TransferObjects may send objects to — the local signer's own sender/agent address. */
  allowedRecipients: readonly string[];
  /** Hard ceiling, in MIST, on the sum of every SplitCoins amount in the PTB. */
  budgetCeilingMist: bigint;
}

export interface OnboardingInspection {
  targets: string[];
  totalSplitMist: bigint;
  transferRecipients: string[];
}

function onboardingMoveCallTarget(packageId: string, module: string, fn: string): string {
  return `${normalizeSuiAddress(packageId)}::${module}::${fn}`;
}

function onboardingAllowlistTargetSet(allowedTargets: readonly string[]): Set<string> {
  return new Set(
    allowedTargets.map((target) => {
      const [packageId, module, fn, extra] = target.split('::');
      if (!packageId || !module || !fn || extra) {
        throw new Error(`Invalid onboarding allowlist target ${target}.`);
      }
      return onboardingMoveCallTarget(packageId, module, fn);
    }),
  );
}

function onboardingInputAt(
  inputs: ReturnType<Transaction['getData']>['inputs'],
  argument: unknown,
  label: string,
) {
  const value = argument as { $kind?: string; Input?: number };
  if (value.$kind !== 'Input' || value.Input == null) throw new Error(`${label} is not a plain input.`);
  const input = inputs[value.Input];
  if (!input) throw new Error(`${label} input is missing.`);
  return input;
}

function onboardingPureBytes(
  inputs: ReturnType<Transaction['getData']>['inputs'],
  argument: unknown,
  label: string,
): Buffer {
  const input = onboardingInputAt(inputs, argument, label);
  if (input.$kind !== 'Pure') throw new Error(`${label} must be a static pure value.`);
  return Buffer.from(input.Pure.bytes, 'base64');
}

function onboardingU64(
  inputs: ReturnType<Transaction['getData']>['inputs'],
  argument: unknown,
  label: string,
): bigint {
  const bytes = onboardingPureBytes(inputs, argument, label);
  if (bytes.length !== 8) throw new Error(`${label} is not a u64.`);
  return bytes.readBigUInt64LE();
}

function onboardingAddress(
  inputs: ReturnType<Transaction['getData']>['inputs'],
  argument: unknown,
  label: string,
): string {
  const bytes = onboardingPureBytes(inputs, argument, label);
  if (bytes.length !== 32) throw new Error(`${label} is not a 32-byte address.`);
  return normalizeSuiAddress(`0x${bytes.toString('hex')}`);
}

/**
 * Structurally validates a setup or trade-cap onboarding PTB against an explicit allowlist. Throws on
 * the first violation (fail-closed); returns a summary of what it saw on success.
 */
export function inspectOnboarding(transaction: Transaction, allow: OnboardingAllowlist): OnboardingInspection {
  const data = transaction.getData();
  const allowedTargetSet = onboardingAllowlistTargetSet(allow.allowedTargets);
  const allowedRecipientSet = new Set(allow.allowedRecipients.map((address) => normalizeSuiAddress(address)));

  const targets: string[] = [];
  const transferRecipients: string[] = [];
  let totalSplitMist = 0n;

  data.commands.forEach((command, index) => {
    if (command.$kind === 'MoveCall') {
      const target = onboardingMoveCallTarget(command.MoveCall.package, command.MoveCall.module, command.MoveCall.function);
      if (!allowedTargetSet.has(target)) {
        throw new Error(`Onboarding PTB command ${index} calls an unexpected target ${target}.`);
      }
      targets.push(target);
      return;
    }
    if (command.$kind === 'SplitCoins') {
      command.SplitCoins.amounts.forEach((amount, amountIndex) => {
        totalSplitMist += onboardingU64(data.inputs, amount, `SplitCoins command ${index} amount ${amountIndex}`);
      });
      return;
    }
    if (command.$kind === 'MergeCoins') {
      return;
    }
    if (command.$kind === 'TransferObjects') {
      const recipient = onboardingAddress(data.inputs, command.TransferObjects.address, `TransferObjects command ${index} recipient`);
      if (!allowedRecipientSet.has(recipient)) {
        throw new Error(`Onboarding PTB command ${index} transfers to an unexpected address ${recipient}.`);
      }
      transferRecipients.push(recipient);
      return;
    }
    throw new Error(`Onboarding PTB command ${index} has an unsupported kind ${command.$kind}.`);
  });

  if (totalSplitMist > allow.budgetCeilingMist) {
    throw new Error(
      `Onboarding PTB splits ${totalSplitMist} MIST total, exceeding the ${allow.budgetCeilingMist} MIST budget ceiling.`,
    );
  }

  return { targets, totalSplitMist, transferRecipients };
}
