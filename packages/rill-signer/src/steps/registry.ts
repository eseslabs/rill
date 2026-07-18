import type { StepValidator } from './types';
import { deepbookStepValidator } from './deepbook';
import { cetusSwapStepValidator } from './cetus';
import { haedalStakeStepValidator } from './haedal';

/**
 * Per-node-type structural PTB validators, keyed by `EnvelopeStep['nodeType']`. Each validator
 * independently re-derives its Move fragment's exact shape from the PTB bytes — the registry itself
 * makes no trust decisions, it only dispatches to the code that does (see policy.ts's
 * inspectGeneric). A nodeType with no entry here has no way to be signed: inspectGeneric throws
 * fail-closed on lookup miss rather than skipping validation.
 */
export const stepValidators: Record<string, StepValidator> = {
  deepbook_limit_order: deepbookStepValidator,
  cetus_swap: cetusSwapStepValidator,
  haedal_stake: haedalStakeStepValidator,
};
