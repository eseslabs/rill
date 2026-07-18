import type { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

export type TxData = ReturnType<Transaction['getData']>;
export type Command = TxData['commands'][number];

export const normalized = (v: string) => normalizeSuiAddress(v);

export function normalizeTarget(target: string): string {
  const [p, m, f, extra] = target.split('::');
  if (!p || !m || !f || extra) throw new Error(`Invalid Move target ${target}.`);
  return `${normalized(p)}::${m}::${f}`;
}

export function normalizeCoinType(coinType: string): string {
  const [a, m, n, extra] = coinType.split('::');
  if (!a || !m || !n || extra) throw new Error(`Invalid coin type ${coinType}.`);
  return `${normalized(a)}::${m}::${n}`;
}

export const SUI_COIN_TYPE = normalizeCoinType('0x2::sui::SUI');

export function targetOf(command: Command): string {
  return command.$kind === 'MoveCall'
    ? `${normalized(command.MoveCall.package)}::${command.MoveCall.module}::${command.MoveCall.function}`
    : '';
}

export function expectNormalizedMatch(actual: string, expected: string, message: string): void {
  if (normalized(actual) !== normalized(expected)) throw new Error(message);
}

/** All the pure/object/arity readers inspect() used, bound to one transaction's data. */
export function makeReader(data: TxData) {
  const objectIdFromInput = (input: TxData['inputs'][number]): string | undefined => {
    if (input.$kind === 'UnresolvedObject') return normalized(input.UnresolvedObject.objectId);
    if (input.$kind !== 'Object') return undefined;
    if (input.Object.$kind === 'SharedObject') return normalized(input.Object.SharedObject.objectId);
    if (input.Object.$kind === 'ImmOrOwnedObject') return normalized(input.Object.ImmOrOwnedObject.objectId);
    return normalized(input.Object.Receiving.objectId);
  };
  const inputAt = (argument: unknown, label: string) => {
    const v = argument as { $kind?: string; Input?: number };
    if (v.$kind !== 'Input' || v.Input == null) throw new Error(`${label} is not an input.`);
    const input = data.inputs[v.Input];
    if (!input) throw new Error(`${label} input is missing.`);
    return input;
  };
  const pureBytes = (argument: unknown, label: string) => {
    const input = inputAt(argument, label);
    if (input.$kind !== 'Pure') throw new Error(`${label} is not pure.`);
    return Buffer.from(input.Pure.bytes, 'base64');
  };
  return {
    objectIdFromInput,
    objectArgument: (argument: unknown, label: string) => {
      const id = objectIdFromInput(inputAt(argument, label));
      if (!id) throw new Error(`${label} is not an object input.`);
      return id;
    },
    u64: (argument: unknown, label: string) => {
      const b = pureBytes(argument, label);
      if (b.length !== 8) throw new Error(`${label} is not a u64.`);
      return b.readBigUInt64LE();
    },
    byte: (argument: unknown, label: string) => {
      const b = pureBytes(argument, label);
      if (b.length !== 1) throw new Error(`${label} is not a byte.`);
      return b[0];
    },
    exactArity: (args: readonly unknown[], expected: number, label: string) => {
      if (args.length !== expected) throw new Error(`${label} must have exactly ${expected} arguments.`);
    },
  };
}
export type Reader = ReturnType<typeof makeReader>;

/**
 * A step validator inspects the PTB commands for ONE node, starting at `cursor` (the command index
 * after the previous step). It asserts its Move fragment's exact shape and returns the objects/targets
 * it consumed plus the index it advanced to. Throws (fail-closed) on any deviation.
 */
export interface StepContext {
  data: TxData;
  reader: Reader;
  cursor: number;
  /** The command index of the single agent_wallet::spend (funding source), for coin-provenance checks. */
  spendIndex: number;
  spendAmountMist: bigint;
}
export interface StepResult {
  cursor: number;
  targets: string[];
  objectIds: string[];
  guards: string[];
}
export type StepValidator = (ctx: StepContext, step: unknown) => StepResult;
