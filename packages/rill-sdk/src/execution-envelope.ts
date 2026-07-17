import type { ExecutionEnvelope } from './types';

export const EXECUTION_ENVELOPE_VERSION = '1' as const;
export const EXECUTION_ENVELOPE_NETWORKS = ['testnet', 'mainnet'] as const;
export const EXECUTION_ENVELOPE_REQUIRED_STRING_FIELDS = [
  'walletPackageId',
  'walletId',
  'agentCapId',
  'actionId',
  'actionDigest',
  'network',
  'sender',
  'unsignedPtb',
  'preview',
  'expiresAt',
] as const;
export const EXECUTION_ENVELOPE_OPTIONAL_STRING_FIELDS = ['balanceManagerId', 'tradeCapId'] as const;
export const EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS = [
  'allowedTargets',
  'requiredObjectIds',
  'requiredGuards',
] as const;
export const EXECUTION_ENVELOPE_REQUIRED_FIELDS = [
  'version',
  'actionId',
  'actionDigest',
  'network',
  'sender',
  'walletPackageId',
  'walletId',
  'agentCapId',
  'resolvedParams',
  ...EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS,
  'unsignedPtb',
  'preview',
  'simulation',
  'expiresAt',
] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_STRING_FIELDS = [
  'poolKey',
  'poolId',
  'clientOrderId',
  'spendAmountMist',
] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_NUMBER_FIELDS = [
  'price',
  'quantity',
  'depositSui',
] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_BOOLEAN_FIELDS = ['isBid', 'payWithDeep'] as const;
export const EXECUTION_ENVELOPE_RESOLVED_PARAM_REQUIRED_FIELDS = [
  ...EXECUTION_ENVELOPE_RESOLVED_PARAM_STRING_FIELDS,
  ...EXECUTION_ENVELOPE_RESOLVED_PARAM_NUMBER_FIELDS,
  ...EXECUTION_ENVELOPE_RESOLVED_PARAM_BOOLEAN_FIELDS,
] as const;
export const EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS = ['verified', 'unverified'] as const;
export const EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES = ['mutated', 'created', 'deleted'] as const;
export const EXECUTION_ENVELOPE_SIMULATION_REQUIRED_FIELDS = [
  'ok',
  'verification',
  'gasEstimate',
  'balanceChanges',
  'objectChanges',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(options: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function requireString(record: Record<string, unknown>, key: string, path = 'ExecutionEnvelope'): void {
  if (typeof record[key] !== 'string' || record[key] === '') {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
}

function requireFiniteNumber(record: Record<string, unknown>, key: string, path = 'ExecutionEnvelope'): void {
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    throw new Error(`${path}.${key} must be a finite number`);
  }
}

function requireBoolean(record: Record<string, unknown>, key: string, path = 'ExecutionEnvelope'): void {
  if (typeof record[key] !== 'boolean') {
    throw new Error(`${path}.${key} must be boolean`);
  }
}

function requireStringArray(record: Record<string, unknown>, key: string): void {
  if (!Array.isArray(record[key]) || !(record[key] as unknown[]).every((item) => typeof item === 'string')) {
    throw new Error(`ExecutionEnvelope.${key} must be a string array`);
  }
}

function isBalanceChange(value: unknown): boolean {
  return isRecord(value) && ['owner', 'coinType', 'amount'].every((key) => typeof value[key] === 'string');
}

function isObjectChange(value: unknown): boolean {
  return isRecord(value)
    && isOneOf(EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES, value.type)
    && typeof value.objectId === 'string'
    && typeof value.objectType === 'string';
}

export function assertExecutionEnvelope(value: unknown): ExecutionEnvelope {
  if (!isRecord(value)) {
    throw new Error('ExecutionEnvelope must be an object');
  }
  if (value.version !== EXECUTION_ENVELOPE_VERSION) {
    throw new Error('ExecutionEnvelope.version must be 1');
  }

  for (const key of EXECUTION_ENVELOPE_REQUIRED_STRING_FIELDS) {
    requireString(value, key);
  }
  for (const key of EXECUTION_ENVELOPE_OPTIONAL_STRING_FIELDS) {
    if (value[key] !== undefined) {
      requireString(value, key);
    }
  }
  if (!isOneOf(EXECUTION_ENVELOPE_NETWORKS, value.network)) {
    throw new Error('ExecutionEnvelope.network is invalid');
  }

  for (const key of EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS) {
    requireStringArray(value, key);
  }

  if (!isRecord(value.resolvedParams)) {
    throw new Error('ExecutionEnvelope.resolvedParams must be an object');
  }

  if (!isRecord(value.simulation)) {
    throw new Error('ExecutionEnvelope.simulation must be an object');
  }
  const simulation = value.simulation;
  requireBoolean(simulation, 'ok', 'ExecutionEnvelope.simulation');
  if (!isOneOf(EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS, simulation.verification)) {
    throw new Error('ExecutionEnvelope.simulation.verification is invalid');
  }
  if (simulation.error !== undefined && typeof simulation.error !== 'string') {
    throw new Error('ExecutionEnvelope.simulation.error must be a string');
  }
  requireFiniteNumber(simulation, 'gasEstimate', 'ExecutionEnvelope.simulation');
  if (!Array.isArray(simulation.balanceChanges) || !simulation.balanceChanges.every(isBalanceChange)) {
    throw new Error('ExecutionEnvelope.simulation.balanceChanges is invalid');
  }
  if (!Array.isArray(simulation.objectChanges) || !simulation.objectChanges.every(isObjectChange)) {
    throw new Error('ExecutionEnvelope.simulation.objectChanges is invalid');
  }

  return value as unknown as ExecutionEnvelope;
}

export async function digestUnsignedPtb(unsignedPtb: string): Promise<string> {
  const bytes = new TextEncoder().encode(unsignedPtb);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
