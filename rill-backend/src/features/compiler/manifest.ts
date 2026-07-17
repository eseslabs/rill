import type { Transaction } from '@mysten/sui/transactions';

/** One MoveCall in the compiled PTB, as read back out of the bytes. */
export interface ManifestCall {
  /** Position in the PTB command list. Non-MoveCall commands keep their slot. */
  index: number;
  /** `package::module::function` */
  target: string;
  typeArguments: string[];
  /**
   * Every 8-byte Pure argument decoded little-endian, in argument order, as a decimal
   * string. Best-effort: any 8-byte pure decodes, so a u64-shaped value that is not
   * semantically an amount also appears here. Non-pure and non-8-byte args are skipped.
   */
  u64Args: string[];
}

type PtbArgument = { $kind?: string; Input?: number };
type PtbInput = { $kind?: string; Pure?: { bytes: string } };
type PtbMoveCall = {
  package: string;
  module: string;
  function: string;
  typeArguments?: string[];
  arguments?: PtbArgument[];
};

function decodeU64Args(args: PtbArgument[] | undefined, inputs: PtbInput[]): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const arg of args) {
    if (arg.$kind !== 'Input' || arg.Input == null) continue;
    const input = inputs[arg.Input];
    if (input?.$kind !== 'Pure' || !input.Pure) continue;
    const bytes = Buffer.from(input.Pure.bytes, 'base64');
    if (bytes.length !== 8) continue;
    out.push(bytes.readBigUInt64LE().toString());
  }
  return out;
}

/** Read the ordered MoveCall manifest back out of a *compiled* transaction. */
export function deriveCallManifest(tx: Transaction): ManifestCall[] {
  const data = tx.getData();
  const inputs = data.inputs as PtbInput[];
  const calls: ManifestCall[] = [];

  data.commands.forEach((command, index) => {
    const moveCall = (command as { MoveCall?: PtbMoveCall }).MoveCall;
    if (!moveCall) return;
    calls.push({
      index,
      target: `${moveCall.package}::${moveCall.module}::${moveCall.function}`,
      typeArguments: moveCall.typeArguments ?? [],
      u64Args: decodeU64Args(moveCall.arguments, inputs),
    });
  });

  return calls;
}
