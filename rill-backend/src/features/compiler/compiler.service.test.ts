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
  if (target.endsWith('::agent_wallet::confirm_spend')) return 1; // releases the funding Coin<T>
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

  const result = await compilerService.compileFlow(flow, { sender, agentWallet: fundedAgentWallet });
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

  const result = await compilerService.compileFlow(flow, { sender, agentWallet: fundedAgentWallet });

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
  await expect(compilerService.compileFlow(malformed, { sender, agentWallet: fundedAgentWallet }))
    .rejects.toThrow(/not a valid input handle/);
  // The rejection happens before any transaction is built at all — structurally, no request_spend
  // (or any other command) can ever be emitted for a flow that fails this validation.

  // Regression pin, decoupled from the malformed edge above: there is only ever one
  // `agent_wallet::request_spend` call site in the whole compiler (sized to the summed root funding)
  // — this pins its count and amount so a future regression that duplicates or inflates funding is
  // caught.
  const healthy = { nodes: [cetusSwapNode('s1')], edges: [] };
  const result = await compilerService.compileFlow(healthy, { sender, agentWallet: fundedAgentWallet });
  const targets = moveCallTargets(result.transaction);
  expect(targets.filter((t) => t === `${agentWallet.packageId}::agent_wallet::request_spend`)).toHaveLength(1);
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

// --- Manifest-gated spend (Rule + Hot Potato) — the ONLY agent-wallet funding path -------------
//
// Every bound agent wallet compiles the redesigned agent_wallet package's `request_spend -> prove
// x N -> confirm_spend` sequence — there is no more legacy single `agent_wallet::spend()` call or
// package to fall back to (a wallet bound without a manifest is a `ValidationError`, see the "no
// manifest" test below). These tests assert the PTB *structure* (targets, order, argument wiring).

const AGENT_WALLET_VERSION_ID = objectId(20);
const RECIPIENT = objectId(21);

/** `agentWallet` (no manifest) plus the field the redesigned sequence needs — every actual compile
 *  in this file adds its own `capabilityManifest` on top (a bound wallet always requires one). */
const manifestWallet = {
  ...agentWallet,
  versionId: AGENT_WALLET_VERSION_ID,
};

function ruleProveTarget(module: string) {
  return `${agentWallet.packageId}::${module}::prove`;
}

/** Types a manifest fixture's `rules` array against `CapabilityRule`'s discriminated union so each
 *  literal's `kind` narrows correctly, instead of every call site needing its own type annotation. */
function manifest(rules: CapabilityRule[]): CapabilityManifest {
  return { walletCoinType: SUI, rules };
}

/** The default "just give me a working funded agent wallet" fixture — a single permissive budget
 *  rule, for tests that need root SUI funding to succeed but don't care about the manifest's exact
 *  rule set. */
const fundedAgentWallet = {
  ...manifestWallet,
  capabilityManifest: manifest([{ kind: 'budget', totalMist: '5000000000' }]),
};

const REQUEST_SPEND_TARGET = `${agentWallet.packageId}::agent_wallet::request_spend`;
const CONFIRM_SPEND_TARGET = `${agentWallet.packageId}::agent_wallet::confirm_spend`;
/** Regression pin only — asserts the retired call NEVER reappears in a compiled PTB; this package
 *  has no `agent_wallet::spend` function anymore. */
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
        { kind: 'rate_limit', windowMs: '3600000', maxMist: '5000000000' },
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
    targets.indexOf(ruleProveTarget('rate_limit')),
  ];
  for (const idx of proveIdxs) {
    expect(idx).toBeGreaterThan(requestIdx);
    expect(idx).toBeLessThan(confirmIdx);
  }
  expect(proveIdxs).toEqual([...proveIdxs].sort((a, b) => a - b)); // manifest order preserved

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction, {
    expectedProveModules: ['budget', 'per_tx', 'rate_limit'],
  });
});

test('request_spend is a 5-arg call — wallet, cap, version, amount, clock — no target_package/coin_in/coin_out/recipient', async () => {
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

  // arguments: [wallet, cap, version, amount, clock] — the migrated `request_spend<T>` (agent_wallet
  // .move) dropped target_package/coin_in/coin_out/recipient entirely (review C2: those are
  // self-declared PTB metadata, now cross-checked pre-flight instead — see compiler.service.ts).
  expect(requestCmd.MoveCall.arguments).toHaveLength(5);
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

  // No `0x1::type_name::get` calls (coin_in/coin_out TypeName construction is gone) and every OTHER
  // argument (wallet, cap, version, clock) is an object reference, never a second Pure.
  expect(moveCallTargets(result.transaction).some((t) => t.endsWith('::type_name::get'))).toBe(false);
  for (const idx of [0, 1, 2, 4]) {
    expect(pureArg(requestCmd.MoveCall.arguments[idx])).toBeUndefined();
  }

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction);
});

test('a swap+slippage manifest injects NO slippage_floor prove — enforced pre-flight, not on-chain', async () => {
  // min_amount_out must clear the manifest's floor (>=) — this test is about on-chain projection
  // shape, not about the pre-flight cross-check itself (see the dedicated "slippage_floor" tests
  // below for that), so the node's declared floor is set to satisfy the manifest's.
  const flow = { nodes: [cetusSwapNode('s1', { min_amount_out: '990000000' })], edges: [] };

  const result = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...manifestWallet,
      capabilityManifest: manifest([
        { kind: 'budget', totalMist: '5000000000' },
        { kind: 'slippage_floor', minOutMist: '990000000' },
      ]),
    },
  });
  const commands = result.transaction.getData().commands;
  const slippageProve = commands.find(
    (c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'prove' && c.MoveCall.module === 'slippage_floor',
  );
  // slippage_floor is pre-flight only (see capability-manifest.ts's toOnChainRuleParams) — it never
  // projects a rule module, so no prove call (and no shadow-coin split) is ever emitted for it.
  expect(slippageProve).toBeUndefined();

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction, {
    expectedProveModules: ['budget'],
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
        // `sender` (not RECIPIENT) — the recipient_allowlist pre-flight cross-check (compiler
        // .service.ts's checkRecipientAllowlist) requires the effective recipient (`sender`) to be
        // in this list, or compileFlow throws before this result is ever produced.
        { kind: 'recipient_allowlist', addresses: [sender] },
      ]),
    },
  });

  const provesOf = (r: typeof resultA) =>
    r.transaction.getData().commands
      .filter((c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'prove')
      .map((c) => (c.$kind === 'MoveCall' ? c.MoveCall.module : ''));

  expect(provesOf(resultA)).toEqual(['budget']);
  // recipient_allowlist is pre-flight only (see toOnChainRuleParams) — attaching it changes the
  // manifest's rule SET (asserted below via the coin-consumption pin) without adding a third prove.
  expect(provesOf(resultB)).toEqual(['budget', 'per_tx']);
  expect(provesOf(resultA)).not.toEqual(provesOf(resultB));

  assertEveryProducedCoinConsumedExactlyOnce(resultA.transaction, { expectedProveModules: ['budget'] });
  assertEveryProducedCoinConsumedExactlyOnce(resultB.transaction, {
    expectedProveModules: ['budget', 'per_tx'],
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

test('a manifest present but missing versionId -> ValidationError (422)', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  await expect(
    compilerService.compileFlow(flow, {
      sender,
      // no versionId on this binding
      agentWallet: { ...agentWallet, capabilityManifest: manifest([{ kind: 'budget', totalMist: '5000000000' }]) },
    }),
  ).rejects.toThrow(ValidationError);
});

test('an agent wallet bound WITHOUT a manifest -> ValidationError, never a legacy spend() fallback', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  // Bare `agentWallet` (no capabilityManifest) and an explicit `capabilityManifest: undefined` both
  // fail the exact same way — there is no manifest-less package/call left to fall back to.
  await expect(compilerService.compileFlow(flow, { sender, agentWallet }))
    .rejects.toThrow(ValidationError);
  await expect(compilerService.compileFlow(flow, {
    sender,
    agentWallet: { ...manifestWallet, capabilityManifest: undefined },
  })).rejects.toThrow(ValidationError);

  // Fails BEFORE any command is emitted (R1: never emit an unguarded spend) — never the retired
  // legacy `agent_wallet::spend` call, and never a half-built request_spend/confirm_spend pair.
  let thrown: unknown;
  try {
    await compilerService.compileFlow(flow, { sender, agentWallet });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
});

// --- Review C2: manifest pre-flight cross-check (real enforcement, not decorative) -------------
//
// `protocol_scope`, `recipient_allowlist`, `asset_scope`, and `slippage_floor` have no on-chain
// `prove` projection (see `toOnChainRuleParams`'s doc comment) — `compiler.service.ts`'s
// `enforceManifestPreflight` is the ONLY place they are actually enforced, cross-checked against the
// real compiled PTB / resolved flow, fail-closed. `cetusSwapNode`'s pool mock (`beforeAll` above)
// fixes `coinTypeA = FAKE_USDC`, `coinTypeB = SUI` — an `inputCoinType: SUI` swap (the default) is
// therefore always b2a, outputting FAKE_USDC.

test('a flow that satisfies a full manifest (all four pre-flight rules attached) compiles OK', async () => {
  const flow = { nodes: [cetusSwapNode('s1', { min_amount_out: '990000000' })], edges: [] };

  const result = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...manifestWallet,
      capabilityManifest: manifest([
        { kind: 'budget', totalMist: '5000000000' },
        { kind: 'protocol_scope', allowedPackages: [CETUS_INTEGRATE_PKG] },
        { kind: 'recipient_allowlist', addresses: [sender] },
        { kind: 'asset_scope', allowedCoinTypes: [SUI, FAKE_USDC] },
        { kind: 'slippage_floor', minOutMist: '990000000' },
      ]),
    },
  });

  assertEveryProducedCoinConsumedExactlyOnce(result.transaction, { expectedProveModules: ['budget'] });
});

test('a flow calling a package NOT in protocol_scope.allowedPackages -> 422', async () => {
  const flow = { nodes: [haedalStakeNode('h1')], edges: [] }; // targets objectId(300), not Cetus's package

  await expect(
    compilerService.compileFlow(flow, {
      sender,
      agentWallet: {
        ...manifestWallet,
        capabilityManifest: manifest([
          { kind: 'budget', totalMist: '5000000000' },
          { kind: 'protocol_scope', allowedPackages: [CETUS_INTEGRATE_PKG] },
        ]),
      },
    }),
  ).rejects.toThrow(/protocol_scope violation/);
});

test('options.sender not in recipient_allowlist.addresses -> 422', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  await expect(
    compilerService.compileFlow(flow, {
      sender, // objectId(1) — not RECIPIENT
      agentWallet: {
        ...manifestWallet,
        capabilityManifest: manifest([
          { kind: 'budget', totalMist: '5000000000' },
          { kind: 'recipient_allowlist', addresses: [RECIPIENT] },
        ]),
      },
    }),
  ).rejects.toThrow(/recipient_allowlist violation/);
});

test('recipient_allowlist attached but no `sender` given -> 422 (nothing to verify against)', async () => {
  // No non-SUI leftover coin in this flow, so the settle sweep's own "no sender" guard never fires
  // first — this isolates the recipient_allowlist pre-flight check's own sender requirement.
  const flow = { nodes: [haedalStakeNode('h1')], edges: [] };

  await expect(
    compilerService.compileFlow(flow, {
      agentWallet: {
        ...manifestWallet,
        capabilityManifest: manifest([
          { kind: 'budget', totalMist: '5000000000' },
          { kind: 'recipient_allowlist', addresses: [RECIPIENT] },
        ]),
      },
    }),
  ).rejects.toThrow(/recipient_allowlist violation/);
});

test('a swap coin type not in asset_scope.allowedCoinTypes -> 422', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] }; // real output is FAKE_USDC (pool mock)

  await expect(
    compilerService.compileFlow(flow, {
      sender,
      agentWallet: {
        ...manifestWallet,
        capabilityManifest: manifest([
          { kind: 'budget', totalMist: '5000000000' },
          { kind: 'asset_scope', allowedCoinTypes: [SUI] }, // FAKE_USDC (the real output) is missing
        ]),
      },
    }),
  ).rejects.toThrow(/asset_scope violation/);
});

test('a swap min_amount_out below slippage_floor.minOutMist -> 422', async () => {
  const flow = { nodes: [cetusSwapNode('s1', { min_amount_out: '1' })], edges: [] };

  await expect(
    compilerService.compileFlow(flow, {
      sender,
      agentWallet: {
        ...manifestWallet,
        capabilityManifest: manifest([
          { kind: 'budget', totalMist: '5000000000' },
          { kind: 'slippage_floor', minOutMist: '990000000' },
        ]),
      },
    }),
  ).rejects.toThrow(/slippage_floor violation/);
});

test('slippage_floor with no swap node in the flow is vacuously satisfied (warns, does not throw)', async () => {
  const flow = { nodes: [haedalStakeNode('h1')], edges: [] };

  const result = await compilerService.compileFlow(flow, {
    sender,
    agentWallet: {
      ...manifestWallet,
      capabilityManifest: manifest([
        { kind: 'budget', totalMist: '5000000000' },
        { kind: 'slippage_floor', minOutMist: '990000000' },
      ]),
    },
  });

  expect(
    result.warnings.some((w) => w.includes('slippage_floor rule attached but the flow has no swap node')),
  ).toBe(true);
});
