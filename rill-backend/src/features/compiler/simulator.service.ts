import { suiClient } from '../../core/config';
import { DEFAULT_SIMULATE_SENDER } from '../../core/protocols';
import { isCetusDevInspectVersionAbort } from './pool-resolver';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { StrictSimulationResult } from '../../../../packages/rill-sdk/src/types';

export type SimulationResult = StrictSimulationResult;

type UnclassifiedSimulation = Omit<SimulationResult, 'verification'>;

export function classifySimulation(result: UnclassifiedSimulation): SimulationResult {
  return {
    ...result,
    verification:
      !result.ok && isCetusDevInspectVersionAbort(result.error) ? 'unverified' : 'verified',
  };
}

type SimulatedTransaction = SuiClientTypes.Transaction<{
  effects: true;
  balanceChanges: true;
  objectTypes: true;
}>;

type ChangedObject = SuiClientTypes.TransactionEffects['changedObjects'][number];

function classifyObjectChange(change: ChangedObject, objectTypes: Record<string, string> | undefined):
  | { type: 'mutated' | 'created' | 'deleted'; objectId: string; objectType: string }
  | null {
  const objectId = change.objectId;
  if (!objectId) return null;

  if (change.idOperation === 'Created') {
    return { type: 'created', objectId, objectType: objectTypes?.[objectId] ?? '' };
  }
  if (change.idOperation === 'Deleted') {
    return { type: 'deleted', objectId, objectType: objectTypes?.[objectId] ?? '' };
  }
  // Mutated objects have idOperation 'None' but were written to output state.
  if (change.idOperation === 'None' && change.outputState !== 'DoesNotExist') {
    return { type: 'mutated', objectId, objectType: objectTypes?.[objectId] ?? '' };
  }
  return null;
}

export class SimulatorService {
  async simulateTransaction(tx: Transaction, sender?: string): Promise<SimulationResult> {
    const simulateSender = sender || DEFAULT_SIMULATE_SENDER;
    tx.setSenderIfNotSet(simulateSender);

    try {
      const response = await suiClient.simulateTransaction({
        transaction: tx,
        include: { effects: true, balanceChanges: true, objectTypes: true } as SuiClientTypes.SimulateTransactionInclude,
      });

      const parsed = this.parseSimulation(response);
      return classifySimulation(parsed);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown RPC simulation error';
      return classifySimulation({
        ok: false,
        error: message,
        gasEstimate: 0,
        balanceChanges: [],
        objectChanges: [],
      });
    }
  }

  private parseSimulation(
    response: Awaited<ReturnType<typeof suiClient.simulateTransaction>>,
  ): UnclassifiedSimulation {
    const tx = (
      response.$kind === 'Transaction' ? response.Transaction : response.FailedTransaction
    ) as SimulatedTransaction;
    const ok = response.$kind === 'Transaction' && tx.status.success;
    const error = ok ? undefined : tx.status.error?.message;

    const effects = tx.effects;
    const computationCost = parseInt(effects.gasUsed.computationCost, 10);
    const storageCost = parseInt(effects.gasUsed.storageCost, 10);
    const storageRebate = parseInt(effects.gasUsed.storageRebate, 10);
    const gasEstimate = computationCost + Math.max(0, storageCost - storageRebate);

    const balanceChanges = (tx.balanceChanges ?? []).map((change) => ({
      owner: change.address,
      coinType: change.coinType,
      amount: change.amount,
    }));

    const objectTypes = tx.objectTypes;
    const objectChanges = (effects.changedObjects ?? []).flatMap((change) => {
      const classified = classifyObjectChange(change, objectTypes);
      return classified ? [classified] : [];
    });

    return { ok, error, gasEstimate, balanceChanges, objectChanges };
  }
}

export const simulatorService = new SimulatorService();
