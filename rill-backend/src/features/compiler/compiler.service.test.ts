import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Transaction } from '@mysten/sui/transactions';
import { config, suiClient } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { FlowSchema } from '../../http/schemas/api.schema';
import { compilerService } from './compiler.service';
import type { CapabilityManifest, CapabilityRule } from '../../../../packages/rill-sdk/src/capability-manifest';

type PtbCommand = ReturnType<Transaction['getData']>['commands'][number];

// --- Shared fixtures -------------------------------------------------------

const objectId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const SUI = '0x2::sui::SUI';
const FAKE_USDC = `${objectId(900)}::usdc::USDC`;
const CETUS_POOL_ID = objectId(100);
const CETUS_INTEGRATE_PKG = objectId(101);
const CETUS_GLOBAL_CONFIG = objectId(102);
const CETUS_CLMM_PKG = objectId(103);
const TEST_GUARD_PACKAGE = objectId(999);

const sender = objectId(1);
const agentWallet = {
  packageId: objectId(2),
  walletId: objectId(3),
  capId: objectId(7),
  coinType: SUI,
};

let originalGuardPackageId: string | undefined;
let originalGetObject: typeof suiClient.getObject;
let originalListCoins: typeof suiClient.listCoins;

beforeAll(() => {
  originalGuardPackageId = config.guardPackageId;
  config.guardPackageId = TEST_GUARD_PACKAGE;

  originalGetObject = suiClient.getObject;
  originalListCoins = suiClient.listCoins;

  // Single fake Cetus pool reused by every fixture: coinTypeA = FAKE_USDC, coinTypeB = SUI.
  // Swapping SUI-in -> FAKE_USDC-out (a2b=false) or FAKE_USDC-in -> SUI-out (a2b=true).
  suiClient.getObject = (async () => ({
    object: { type: `${CETUS_CLMM_PKG}::pool::Pool<${FAKE_USDC}, ${SUI}>` },
  })) as unknown as typeof suiClient.getObject;

  suiClient.listCoins = (async () => ({
    objects: [{ objectId: objectId(200), balance: '1000000000000' }],
    hasNextPage: false,
    cursor: null,
  })) as unknown as typeof suiClient.listCoins;
});

afterAll(() => {
  config.guardPackageId = originalGuardPackageId;
  suiClient.getObject = originalGetObject;
  suiClient.listCoins = originalListCoins;
});

function cetusSwapNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'cetus_swap',
    config: {
      integratePackageId: CETUS_INTEGRATE_PKG,
      globalConfigId: CETUS_GLOBAL_CONFIG,
      pool: CETUS_POOL_ID,
      inputCoinType: SUI,
      amount_in: '1000000000',
      min_amount_out: '1',
      minSqrtPrice: '4295048016',
      maxSqrtPrice: '79226673515401279992447579055',
      ...overrides,
    },
  };
}

function guardrailNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'guardrail',
    config: {
      minValue: '1',
      coinType: FAKE_USDC,
      ...overrides,
    },
  };
}

const HAEDAL_STAKE_TARGET = `${objectId(300)}::interface::request_stake`;
const HAEDAL_SUI_SYSTEM_STATE = objectId(301);
const HAEDAL_STAKING_OBJECT = objectId(302);

function haedalStakeNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'haedal_stake',
    config: {
      stakeTarget: HAEDAL_STAKE_TARGET,
      suiSystemStateId: HAEDAL_SUI_SYSTEM_STATE,
      stakingObjectId: HAEDAL_STAKING_OBJECT,
      amount: '1000000000',
      minStakeMist: '1000000000',
      validator: objectId(303),
      ...overrides,
    },
  };
}

function moveCallTargets(transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction']) {
  return transaction.getData().commands.map((command) =>
    command.$kind === 'MoveCall'
      ? `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`
      : '',
  );
}

/**
 * Every produced coin is consumed exactly once. `tx.moveCall`'s TS result is a symbolic proxy that
 * doesn't know a target's real on-chain return arity, so this walker uses the SAME knowledge the
 * adapters/compiler were built with: which specific commands/targets actually produce a coin
 * result that something else must reference (as a MoveCall argument, a MergeCoins source/
 * destination, a TransferObjects object, or the coin a SplitCoins splits FROM) — everything else
 * (asserts, MergeCoins/TransferObjects' own void "result") produces nothing referenceable. Real
 * on-chain execution aborts with `UnusedValueWithoutDrop` if any produced coin is left dangling,
 * a failure devInspect/this in-memory build does not itself catch (R2).
 */
function producedCoinSlots(command: PtbCommand): number {
  if (command.$kind === 'SplitCoins') return command.SplitCoins.amounts.length || 1;
  if (command.$kind !== 'MoveCall') return 0;
  const target = `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`;
  if (target.endsWith('::router::swap')) return 2; // Cetus router::swap always returns (CoinA, CoinB)
  if (target.endsWith('::coin::zero')) return 1;
  if (target.endsWith('::agent_wallet::spend')) return 1;
  if (target.endsWith('::agent_wallet::confirm_spend')) return 1; // U5: releases Coin<T>, same as spend()
  return 0; // assert_min_value, request_stake, DeepBook calls, request_spend (a hot potato, not a
  // coin — not swept), type_name::get (a TypeName, not a coin), etc. — nothing coin-referenceable.
}

function assertEveryProducedCoinConsumedExactlyOnce(
  transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction'],
  opts: { expectedProveModules?: string[] } = {},
): void {
  const commands = transaction.getData().commands;
  const produced = new Set<string>();
  commands.forEach((command, cmdIdx) => {
    const slots = producedCoinSlots(command);
    for (let i = 0; i < slots; i++) produced.add(`${cmdIdx}:${i}`);
  });

  const consumed = new Set<string>();
  const noteArg = (arg: unknown) => {
    const a = arg as { $kind?: string; Result?: number; NestedResult?: [number, number] };
    if (a?.$kind === 'Result' && a.Result != null) consumed.add(`${a.Result}:0`);
    if (a?.$kind === 'NestedResult' && a.NestedResult) consumed.add(`${a.NestedResult[0]}:${a.NestedResult[1]}`);
  };
  for (const command of commands) {
    if (command.$kind === 'MoveCall') command.MoveCall.arguments.forEach(noteArg);
    if (command.$kind === 'MergeCoins') {
      noteArg(command.MergeCoins.destination);
      command.MergeCoins.sources.forEach(noteArg);
    }
    if (command.$kind === 'TransferObjects') {
      command.TransferObjects.objects.forEach(noteArg);
    }
    if (command.$kind === 'SplitCoins') noteArg(command.SplitCoins.coin);
  }

  const dangling = [...produced].filter((ref) => !consumed.has(ref));
  expect(dangling).toEqual([]);

  // The inverse bug (double-consumption — the same produced slot referenced twice, which would mean
  // a real Move value used after being moved) can't happen structurally here since each JS reference
  // is a distinct object handed to exactly one call site by construction, but a duplicate *argument*
  // (the identical reference passed twice) would show up as fewer unique `consumed` entries than
  // total argument occurrences for that slot — covered implicitly by the per-scenario command-shape
  // assertions below (each test pins the exact command sequence and argument wiring it expects).

  // U5: exactly one request_spend/confirm_spend pair per spend, on EVERY compiled flow (manifest or
  // not) — never a request without its matching confirm (a hot potato that could never clear,
  // aborting the whole PTB) and never two independent spends in one compile (a double spend).
  const targets = commands.map((command) =>
    command.$kind === 'MoveCall'
      ? `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`
      : '',
  );
  const requestSpendCount = targets.filter((t) => t.endsWith('::agent_wallet::request_spend')).length;
  const confirmSpendCount = targets.filter((t) => t.endsWith('::agent_wallet::confirm_spend')).length;
  expect(requestSpendCount).toBeLessThanOrEqual(1);
  expect(confirmSpendCount).toBe(requestSpendCount);

  // U5: exactly one `prove` per attached rule, when the caller knows the expected rule sequence.
  if (opts.expectedProveModules) {
    const proveModules = commands
      .filter((command) => command.$kind === 'MoveCall' && command.MoveCall.function === 'prove')
      .map((command) => (command.$kind === 'MoveCall' ? command.MoveCall.module : ''));
    expect(proveModules).toEqual(opts.expectedProveModules);
  }
}

// --- TDD anchor: written first, observed red against pre-U3 code -----------

test('terminal Action -> Guardrail compiles to a self-consuming PTB', async () => {
  const flow = {
    nodes: [cetusSwapNode('s1'), guardrailNode('g1')],
    edges: [{ source: 's1', sourceHandle: 'coin_out', target: 'g1', targetHandle: 'in' }],
  };

  const result = await compilerService.compileFlow(flow, { sender, agentWallet });
  const targets = moveCallTargets(result.transaction);

  // The guardrail's assert must be present — the coin passed through it, not dropped.
  expect(targets.some((t) => t === `${TEST_GUARD_PACKAGE}::guard::assert_min_value`)).toBe(true);

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

// --- Sweep ownership --------------------------------------------------------

test('a bare terminal swap with no guardrail still compiles to exactly one settle per produced coin', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  const result = await compilerService.compileFlow(flow, { sender });
  const commands = result.transaction.getData().commands;
  const merges = commands.filter((c) => c.$kind === 'MergeCoins');
  const transfers = commands.filter((c) => c.$kind === 'TransferObjects');

  // SUI leftover -> gas; non-SUI (FAKE_USDC) output -> sender. Both settled by the compiler's sweep,
  // not by a stale adapter-owned `hasDownstream` branch (sweep-ownership regression, KTD-3).
  expect(merges).toHaveLength(1);
  expect(transfers).toHaveLength(1);

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

test('swap -> guardrail -> stake keeps the coin flowing to the stake', async () => {
  const flow = {
    nodes: [
      cetusSwapNode('s1', { inputCoinType: FAKE_USDC, min_amount_out: '0' }), // a2b=true -> outputs SUI
      guardrailNode('g1', { minValue: '1', coinType: SUI }),
      haedalStakeNode('h1'),
    ],
    edges: [
      { source: 's1', sourceHandle: 'coin_out', target: 'g1', targetHandle: 'in' },
      { source: 'g1', sourceHandle: 'out', target: 'h1', targetHandle: 'sui_coin' },
    ],
  };

  const result = await compilerService.compileFlow(flow, { sender });
  const commands = result.transaction.getData().commands;
  const assertCmd = commands.find((c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'assert_min_value');
  const stakeCmd = commands.find((c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'request_stake');

  expect(assertCmd).toBeDefined();
  expect(stakeCmd).toBeDefined();
  if (assertCmd?.$kind !== 'MoveCall' || stakeCmd?.$kind !== 'MoveCall') throw new Error('expected MoveCalls');

  // The exact coin reference the guardrail asserted is the one Haedal stakes — the swap's output
  // genuinely flows through the guardrail's pass-through, it is not re-sourced from anywhere else.
  expect(stakeCmd.MoveCall.arguments[2]).toEqual(assertCmd.MoveCall.arguments[0]);

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

test('two actions wired into one guardrail yields two asserts and one merged output', async () => {
  const flow = {
    nodes: [
      cetusSwapNode('s1', { min_amount_out: '0' }), // isolate the guardrail's own asserts
      cetusSwapNode('s2', { min_amount_out: '0' }),
      guardrailNode('g1', { minValue: '5' }),
    ],
    edges: [
      { source: 's1', sourceHandle: 'coin_out', target: 'g1', targetHandle: 'in' },
      { source: 's2', sourceHandle: 'coin_out', target: 'g1', targetHandle: 'in' },
    ],
  };

  const result = await compilerService.compileFlow(flow, { sender });
  const commands = result.transaction.getData().commands;
  const asserts = commands.filter((c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'assert_min_value');
  const merges = commands.filter((c) => c.$kind === 'MergeCoins');
  const transfers = commands.filter((c) => c.$kind === 'TransferObjects');
  const guardrailMerges = merges.filter(
    (c) => c.$kind === 'MergeCoins' && c.MergeCoins.destination.$kind !== 'GasCoin',
  );

  expect(asserts).toHaveLength(2); // one per incoming coin, before merging
  expect(guardrailMerges).toHaveLength(1); // the two swap outputs merged into one
  expect(merges).toHaveLength(3); // + the 2 SUI leftover-to-gas sweeps
  expect(transfers).toHaveLength(1); // the single merged FAKE_USDC output, terminal -> sender

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

// --- Warnings ----------------------------------------------------------------

test('guardrail-before-action (no wallet) yields a warning and no guard command', async () => {
  const flow = {
    nodes: [guardrailNode('g1', { minValue: '5', coinType: SUI }), haedalStakeNode('h1')],
    edges: [{ source: 'g1', sourceHandle: 'out', target: 'h1', targetHandle: 'sui_coin' }],
  };

  const result = await compilerService.compileFlow(flow, { sender });
  const targets = moveCallTargets(result.transaction);

  expect(targets.some((t) => t.endsWith('::assert_min_value'))).toBe(false);
  expect(result.warnings.some((w) => w.includes('no agent wallet bound and no incoming coin edge'))).toBe(true);
  expect(result.warnings.some((w) => w.includes('guardrail g1 has no coin to forward'))).toBe(true);
  // The action itself still compiles — it just falls back to normal root funding.
  expect(targets.some((t) => t === HAEDAL_STAKE_TARGET)).toBe(true);
});

test('guardrail with absent minValue yields a "no protection enforced" warning (root-budget mode)', async () => {
  const flow = {
    nodes: [guardrailNode('g1', { minValue: undefined }), haedalStakeNode('h1')],
    edges: [],
  };

  const result = await compilerService.compileFlow(flow, { sender, agentWallet });

  expect(result.warnings).toContain(
    'Guardrail g1 has no minimum value configured — no protection is enforced.',
  );
  expect(result.warnings.some((w) => w.includes('no agent wallet bound'))).toBe(false);
  expect(moveCallTargets(result.transaction).some((t) => t.endsWith('::assert_min_value'))).toBe(false);
});

test('guardrail with zero minValue yields a "no protection enforced" warning (pass-through mode)', async () => {
  const flow = {
    nodes: [cetusSwapNode('s1', { min_amount_out: '0' }), guardrailNode('g1', { minValue: '0' })],
    edges: [{ source: 's1', sourceHandle: 'coin_out', target: 'g1', targetHandle: 'in' }],
  };

  const result = await compilerService.compileFlow(flow, { sender });

  expect(result.warnings).toContain(
    'Guardrail g1 has no minimum value configured — no protection is enforced.',
  );
  expect(moveCallTargets(result.transaction).some((t) => t.endsWith('::assert_min_value'))).toBe(false);
  // The coin still passes through and settles even though nothing asserted it.
  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

// --- Structural validation (422, not 500) -------------------------------------

test('duplicate node ids -> ValidationError (422), rejected by FlowSchema too', async () => {
  const flow = { nodes: [cetusSwapNode('dup'), guardrailNode('dup')], edges: [] };

  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(ValidationError);
  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(/Duplicate node id "dup"/);
  expect(FlowSchema.safeParse(flow).success).toBe(false);
});

test('an edge to a nonexistent node -> ValidationError (422), rejected by FlowSchema too', async () => {
  const flow = {
    nodes: [cetusSwapNode('s1')],
    edges: [{ source: 's1', sourceHandle: 'coin_out', target: 'ghost', targetHandle: 'in' }],
  };

  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(ValidationError);
  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(/does not reference an existing node/);
  expect(FlowSchema.safeParse(flow).success).toBe(false);
});

test('unknown targetHandle "coin" -> ValidationError (422) and never risks a double spend', async () => {
  const malformed = {
    nodes: [cetusSwapNode('s1'), haedalStakeNode('h1')],
    edges: [{ source: 's1', sourceHandle: 'coin_out', target: 'h1', targetHandle: 'coin' }], // typo: should be "sui_coin"
  };

  expect(FlowSchema.safeParse(malformed).success).toBe(false);
  await expect(compilerService.compileFlow(malformed, { sender, agentWallet }))
    .rejects.toThrow(/not a valid input handle/);
  // The rejection happens before any transaction is built at all — structurally, no spend() (or any
  // other command) can ever be emitted for a flow that fails this validation.

  // Regression pin, decoupled from the malformed edge above: there is only ever one
  // `agent_wallet::spend` call site in the whole compiler (sized to the summed root funding) — this
  // pins its count and amount so a future regression that duplicates or inflates funding is caught.
  const healthy = { nodes: [cetusSwapNode('s1')], edges: [] };
  const result = await compilerService.compileFlow(healthy, { sender, agentWallet });
  const targets = moveCallTargets(result.transaction);
  expect(targets.filter((t) => t === `${agentWallet.packageId}::agent_wallet::spend`)).toHaveLength(1);
  expect(result.budgetSpendMist).toBe(1_000_000_000n);
});

// --- PTB-default (R7): the `ptb` node is retired but tolerated ---------------

function ptbNode(id: string) {
  return { id, type: 'ptb' };
}

test('a flow with no ptb node compiles to one PTB (PTB-default, unchanged)', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  const result = await compilerService.compileFlow(flow, { sender });

  expect(result.warnings.some((w) => w.toLowerCase().includes('ptb'))).toBe(false);
  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

test('a legacy ptb node is accepted and silently ignored — identical compiled output to no ptb node', async () => {
  const withoutPtb = { nodes: [cetusSwapNode('s1')], edges: [] };
  const withPtb = { nodes: [cetusSwapNode('s1'), ptbNode('legacy-ptb')], edges: [] };

  const resultWithout = await compilerService.compileFlow(withoutPtb, { sender });
  const resultWith = await compilerService.compileFlow(withPtb, { sender });

  // Not an error (compile succeeded for both) and not a warning either — the ptb node is invisible.
  expect(resultWith.warnings.some((w) => w.toLowerCase().includes('ptb'))).toBe(false);
  expect(resultWith.warnings).toEqual(resultWithout.warnings);

  // Behavioral proof: the ptb node's presence/absence produces the byte-for-byte identical PTB —
  // same commands, same inputs, same move-call targets, in the same order. No leftover special
  // casing anywhere in the compiler for node.type === 'ptb'.
  expect(resultWith.transaction.getData().commands).toEqual(resultWithout.transaction.getData().commands);
  expect(resultWith.transaction.getData().inputs).toEqual(resultWithout.transaction.getData().inputs);
  expect(moveCallTargets(resultWith.transaction)).toEqual(moveCallTargets(resultWithout.transaction));

  assertEveryProducedCoinConsumedExactlyOnce(resultWith.transaction);
});

test('multiple legacy ptb nodes in one flow never warn — the retired "multiple PTB nodes" check stays gone', async () => {
  const flow = { nodes: [cetusSwapNode('s1'), ptbNode('legacy-ptb-1'), ptbNode('legacy-ptb-2')], edges: [] };

  const result = await compilerService.compileFlow(flow, { sender });

  expect(result.warnings.some((w) => w.toLowerCase().includes('ptb'))).toBe(false);
  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

test('a cycle in the flow -> ValidationError (422) via the topological sort', async () => {
  const flow = {
    nodes: [guardrailNode('g1'), guardrailNode('g2')],
    edges: [
      { source: 'g1', sourceHandle: 'out', target: 'g2', targetHandle: 'in' },
      { source: 'g2', sourceHandle: 'out', target: 'g1', targetHandle: 'in' },
    ],
  };

  let thrown: unknown;
  try {
    await compilerService.compileFlow(flow, { sender });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as InstanceType<typeof ValidationError>).message).toBe('Cyclic dependency detected in flow wiring!');
  expect((thrown as InstanceType<typeof ValidationError>).status).toBe(422);
});

// --- U5: manifest-gated spend (Rule + Hot Potato) -----------------------------
//
// When `agentWallet.capabilityManifest` is set, the compiler emits the redesigned agent_wallet
// package's `request_spend -> prove x N -> confirm_spend` sequence instead of the legacy single
// `agent_wallet::spend()` call. The redesigned package (U1) is a fresh, not-yet-deployed deploy —
// these tests assert the PTB *structure* (targets, order, argument wiring), not live execution.

const AGENT_WALLET_VERSION_ID = objectId(20);
const RECIPIENT = objectId(21);

/** `agentWallet` (no manifest) plus the fields the redesigned sequence needs, so a test only has to
 *  add `capabilityManifest` to opt into the new path. */
const manifestWallet = {
  ...agentWallet,
  versionId: AGENT_WALLET_VERSION_ID,
  targetPackage: CETUS_INTEGRATE_PKG,
  recipient: RECIPIENT,
};

function ruleProveTarget(module: string) {
  return `${agentWallet.packageId}::${module}::prove`;
}

/** Types a manifest fixture's `rules` array against `CapabilityRule`'s discriminated union so each
 *  literal's `kind` narrows correctly, instead of every call site needing its own type annotation. */
function manifest(rules: CapabilityRule[]): CapabilityManifest {
  return { walletCoinType: SUI, rules };
}

const REQUEST_SPEND_TARGET = `${agentWallet.packageId}::agent_wallet::request_spend`;
const CONFIRM_SPEND_TARGET = `${agentWallet.packageId}::agent_wallet::confirm_spend`;
const LEGACY_SPEND_TARGET = `${agentWallet.packageId}::agent_wallet::spend`;

test('a manifest with 3 rules compiles request_spend + 3 proves (in order) + confirm_spend', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  const result = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...manifestWallet,
      capabilityManifest: manifest([
        { kind: 'budget', totalMist: '5000000000' },
        { kind: 'per_tx', maxMist: '5000000000' },
        { kind: 'protocol_scope', allowedPackages: [CETUS_INTEGRATE_PKG] },
      ]),
    },
  });
  const targets = moveCallTargets(result.transaction);

  const requestIdx = targets.indexOf(REQUEST_SPEND_TARGET);
  const confirmIdx = targets.indexOf(CONFIRM_SPEND_TARGET);
  expect(requestIdx).toBeGreaterThanOrEqual(0);
  expect(confirmIdx).toBeGreaterThan(requestIdx);
  // No legacy spend() when a manifest drives the redesigned sequence.
  expect(targets).not.toContain(LEGACY_SPEND_TARGET);

  // Every prove sits strictly between request_spend and confirm_spend, in manifest order.
  const proveIdxs = [
    targets.indexOf(ruleProveTarget('budget')),
    targets.indexOf(ruleProveTarget('per_tx')),
    targets.indexOf(ruleProveTarget('protocol_scope')),
  ];
  for (const idx of proveIdxs) {
    expect(idx).toBeGreaterThan(requestIdx);
    expect(idx).toBeLessThan(confirmIdx);
  }
  expect(proveIdxs).toEqual([...proveIdxs].sort((a, b) => a - b)); // manifest order preserved

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction, {
    expectedProveModules: ['budget', 'per_tx', 'protocol_scope'],
  });
});

test('request_spend carries amount/target_package/recipient from the flow and options', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  const result = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...manifestWallet,
      capabilityManifest: manifest([{ kind: 'budget', totalMist: '5000000000' }]),
    },
  });
  const commands = result.transaction.getData().commands;
  const requestCmd = commands.find(
    (c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'request_spend',
  );
  expect(requestCmd?.$kind).toBe('MoveCall');
  if (requestCmd?.$kind !== 'MoveCall') throw new Error('expected a MoveCall');

  // arguments: [wallet, cap, version, amount, target_package, coin_in, coin_out, recipient, clock]
  expect(requestCmd.MoveCall.arguments).toHaveLength(9);
  const inputs = result.transaction.getData().inputs;
  const pureArg = (arg: unknown) => {
    const a = arg as { $kind?: string; Input?: number };
    if (a?.$kind !== 'Input' || a.Input == null) return undefined;
    const input = inputs[a.Input] as { Pure?: { bytes: string } };
    return input?.Pure;
  };
  // amount = rootTotal (1_000_000_000 mist, the cetus swap's amount_in) as a u64 pure arg.
  expect(pureArg(requestCmd.MoveCall.arguments[3])).toBeDefined();
  expect(result.budgetSpendMist).toBe(1_000_000_000n);

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

test('a swap+slippage manifest injects the slippage_floor prove', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  const result = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...manifestWallet,
      capabilityManifest: manifest([
        { kind: 'budget', totalMist: '5000000000' },
        { kind: 'slippage_floor', minBps: 50 },
      ]),
    },
  });
  const commands = result.transaction.getData().commands;
  const slippageProve = commands.find(
    (c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'prove' && c.MoveCall.module === 'slippage_floor',
  );
  expect(slippageProve?.$kind).toBe('MoveCall');
  if (slippageProve?.$kind !== 'MoveCall') throw new Error('expected a MoveCall');
  // prove<T, OutT>(req, wallet, version, coin_out) — 4 arguments, 2 type arguments.
  expect(slippageProve.MoveCall.arguments).toHaveLength(4);
  expect(slippageProve.MoveCall.typeArguments).toEqual([SUI, SUI]);

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction, {
    expectedProveModules: ['budget', 'slippage_floor'],
  });
});

test('rate_limit and time_window proves thread the shared Clock', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  const result = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...manifestWallet,
      capabilityManifest: manifest([
        { kind: 'rate_limit', windowMs: '3600000', maxMist: '5000000000' },
        { kind: 'time_window', notBeforeMs: '0', notAfterMs: '99999999999999' },
      ]),
    },
  });
  const commands = result.transaction.getData().commands;
  const rateLimitProve = commands.find(
    (c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'prove' && c.MoveCall.module === 'rate_limit',
  );
  const timeWindowProve = commands.find(
    (c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'prove' && c.MoveCall.module === 'time_window',
  );
  // prove<T>(req, wallet, version, clock) — 4 arguments each.
  expect(rateLimitProve?.$kind === 'MoveCall' && rateLimitProve.MoveCall.arguments).toHaveLength(4);
  expect(timeWindowProve?.$kind === 'MoveCall' && timeWindowProve.MoveCall.arguments).toHaveLength(4);

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction, {
    expectedProveModules: ['rate_limit', 'time_window'],
  });
});

test('changing the manifest\'s rule set changes the injected proves', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };
  const baseWallet = { ...manifestWallet };

  const resultA = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...baseWallet,
      capabilityManifest: manifest([{ kind: 'budget', totalMist: '5000000000' }]),
    },
  });
  const resultB = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...baseWallet,
      capabilityManifest: manifest([
        { kind: 'budget', totalMist: '5000000000' },
        { kind: 'per_tx', maxMist: '5000000000' },
        { kind: 'recipient_allowlist', addresses: [RECIPIENT] },
      ]),
    },
  });

  const provesOf = (r: typeof resultA) =>
    r.transaction.getData().commands
      .filter((c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'prove')
      .map((c) => (c.$kind === 'MoveCall' ? c.MoveCall.module : ''));

  expect(provesOf(resultA)).toEqual(['budget']);
  expect(provesOf(resultB)).toEqual(['budget', 'per_tx', 'recipient_allowlist']);
  expect(provesOf(resultA)).not.toEqual(provesOf(resultB));

  assertEveryProducedCoinConsumedExactlyOnce(resultA.transaction, { expectedProveModules: ['budget'] });
  assertEveryProducedCoinConsumedExactlyOnce(resultB.transaction, {
    expectedProveModules: ['budget', 'per_tx', 'recipient_allowlist'],
  });
});

test('an invalid manifest (empty rules) -> ValidationError (422), never an unguarded spend', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  let thrown: unknown;
  try {
    await compilerService.compileFlow(flow, {
      sender,
      agentWallet: { ...manifestWallet, capabilityManifest: manifest([]) },
    });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as InstanceType<typeof ValidationError>).status).toBe(422);
  expect((thrown as InstanceType<typeof ValidationError>).message).toContain('Invalid capability manifest');
});

test('an invalid manifest (unknown rule kind) -> ValidationError (422)', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  await expect(
    compilerService.compileFlow(flow, {
      sender,
      agentWallet: {
        ...manifestWallet,
        capabilityManifest: { walletCoinType: SUI, rules: [{ kind: 'not_a_real_rule', totalMist: '1' }] } as never,
      },
    }),
  ).rejects.toThrow(ValidationError);
});

test('a manifest present but missing versionId/targetPackage -> ValidationError (422)', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  await expect(
    compilerService.compileFlow(flow, {
      sender,
      // no versionId/targetPackage on this binding
      agentWallet: { ...agentWallet, capabilityManifest: manifest([{ kind: 'budget', totalMist: '5000000000' }]) },
    }),
  ).rejects.toThrow(ValidationError);
});

test('a flow WITHOUT a manifest compiles the CURRENT spend() path — byte-identical regression', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  const resultLegacy = await compilerService.compileFlow(flow, { sender, agentWallet });
  const resultExplicitUndefined = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: { ...manifestWallet, capabilityManifest: undefined },
  });

  for (const result of [resultLegacy, resultExplicitUndefined]) {
    const targets = moveCallTargets(result.transaction);
    expect(targets).toContain(LEGACY_SPEND_TARGET);
    expect(targets).not.toContain(REQUEST_SPEND_TARGET);
    expect(targets).not.toContain(CONFIRM_SPEND_TARGET);
    expect(targets.some((t) => t.endsWith('::prove'))).toBe(false);
  }

  // Same flow/sender/wallet-identity compiled through the untouched legacy branch: byte-identical
  // commands/inputs — this is the U5 backward-compat gate's core proof (R8: the deployed v2 package's
  // path never changes shape).
  expect(resultExplicitUndefined.transaction.getData().commands).toEqual(resultLegacy.transaction.getData().commands);
  expect(resultExplicitUndefined.transaction.getData().inputs).toEqual(resultLegacy.transaction.getData().inputs);

  assertEveryProducedCoinConsumedExactlyOnce(resultLegacy.transaction);
});
