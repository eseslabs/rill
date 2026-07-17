import type { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { suiClient } from '../../core/config';

/** Base64-encoded transaction JSON with SDK intents resolved, ready for local signing. */
export async function serializeUnsignedPtb(tx: Transaction): Promise<string> {
  return Buffer.from(await tx.toJSON({ client: suiClient })).toString('base64');
}

export function inspectTransaction(tx: Transaction): {
  allowedTargets: string[];
  objectIds: string[];
} {
  const data = tx.getData();
  const allowedTargets = data.commands.flatMap((command) =>
    command.$kind === 'MoveCall'
      ? [`${normalizeSuiAddress(command.MoveCall.package)}::${command.MoveCall.module}::${command.MoveCall.function}`]
      : [],
  );
  const objectIds = data.inputs.flatMap((input) => {
    if (input.$kind === 'UnresolvedObject') {
      return [normalizeSuiAddress(input.UnresolvedObject.objectId)];
    }
    if (input.$kind !== 'Object') return [];
    if (input.Object.$kind === 'SharedObject') {
      return [normalizeSuiAddress(input.Object.SharedObject.objectId)];
    }
    if (input.Object.$kind === 'ImmOrOwnedObject') {
      return [normalizeSuiAddress(input.Object.ImmOrOwnedObject.objectId)];
    }
    return [normalizeSuiAddress(input.Object.Receiving.objectId)];
  });

  return {
    allowedTargets: [...new Set(allowedTargets)],
    objectIds: [...new Set(objectIds)],
  };
}
