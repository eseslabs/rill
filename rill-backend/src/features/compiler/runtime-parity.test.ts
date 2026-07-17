import { expect, test } from 'bun:test';
import { mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { config } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { resolveEffectiveFlow } from '../../core/node-config';
import { compilerService } from './compiler.service';
import { previewService } from './preview.service';

const objectId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function inputU64(transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction'], argument: unknown) {
  return inputBytes(transaction, argument).readBigUInt64LE();
}

function inputBool(transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction'], argument: unknown) {
  return inputBytes(transaction, argument)[0] === 1;
}

function inputBytes(
  transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction'],
  argument: unknown,
) {
  const arg = argument as { $kind: string; Input?: number };
  if (arg.$kind !== 'Input' || arg.Input == null) throw new Error('expected input argument');
  const input = transaction.getData().inputs[arg.Input] as { $kind: string; Pure?: { bytes: string } };
  if (input.$kind !== 'Pure' || !input.Pure) throw new Error('expected pure input');
  return Buffer.from(input.Pure.bytes, 'base64');
}

test('node inputs cannot override static package or object config', () => {
  const trustedPackage = objectId(9);
  const trustedGlobalConfig = objectId(10);
  const resolved = resolveEffectiveFlow({
    nodes: [{
      id: 'swap',
      type: 'cetus_swap',
      config: {
        integratePackageId: trustedPackage,
        globalConfigId: trustedGlobalConfig,
        amount_in: '1',
      },
      inputs: {
        integratePackageId: objectId(11),
        globalConfigId: objectId(12),
        amount_in: '2',
      },
    }],
    edges: [],
  });

  expect(resolved.nodes[0].config?.integratePackageId).toBe(trustedPackage);
  expect(resolved.nodes[0].config?.globalConfigId).toBe(trustedGlobalConfig);
  expect(resolved.nodes[0].config?.amount_in).toBe('2');
});

test('runtime params reject every key without an allowed matching node', () => {
  const flow = {
    nodes: [{ id: 'stake', type: 'haedal_stake' }],
    edges: [],
  };
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ amount: '1', staleAmount: '2' }, 'staleAmount'],
    [{ price: 1.25 }, 'price'],
  ];

  for (const [runtimeParams, key] of cases) {
    let thrown: unknown;
    try {
      resolveEffectiveFlow(flow, runtimeParams);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toBe(
      `Runtime parameter "${key}" does not match an allowed runtime key for any node in this flow.`,
    );
  }
});

test('Cetus runtime params cannot override the published pool', () => {
  const publishedPool = objectId(20);
  const flow = {
    nodes: [{
      id: 'swap',
      type: 'cetus_swap',
      inputs: { pool: publishedPool },
    }],
    edges: [],
  };

  expect(resolveEffectiveFlow(flow).nodes[0].config?.pool).toBe(publishedPool);
  expect(() => resolveEffectiveFlow(flow, { pool: objectId(21) })).toThrow(
    'Runtime parameter "pool" does not match an allowed runtime key for any node in this flow.',
  );
});

test('flat runtime params reject ambiguous duplicate DeepBook nodes', () => {
  let thrown: unknown;
  try {
    resolveEffectiveFlow(
      {
        nodes: [
          { id: 'order-1', type: 'deepbook_limit_order' },
          { id: 'order-2', type: 'deepbook_limit_order' },
        ],
        edges: [],
      },
      { price: 1.25 },
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as Error).message).toBe(
    'Flat runtime params for "deepbook_limit_order" require one matching node; found 2.',
  );
});

test('DeepBook runtime values drive preview and compiled PTB instead of stored config', async () => {
  const staleManager = objectId(1);
  const runtimeManager = objectId(2);
  const runtimeTradeCap = objectId(3);
  const pools = config.network === 'testnet' ? testnetPools : mainnetPools;
  const runtimePoolKey = config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC';
  const result = await compilerService.compileFlow(
    {
      nodes: [{
        id: 'order',
        type: 'deepbook_limit_order',
        config: {
          poolKey: 'DEEP_SUI',
          balanceManagerId: staleManager,
          tradeCapId: objectId(4),
          price: 99,
          quantity: 99,
          isBid: true,
          payWithDeep: true,
          clientOrderId: '11',
          depositSui: 0,
        },
      }],
      edges: [],
    },
    {
      sender: objectId(5),
      agentWallet: {
        packageId: objectId(6),
        walletId: objectId(7),
        capId: objectId(8),
        coinType: '0x2::sui::SUI',
      },
    },
    {
      poolKey: runtimePoolKey,
      balanceManagerId: runtimeManager,
      tradeCapId: runtimeTradeCap,
      price: 1.25,
      quantity: 0.01,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '22',
      depositSui: 0.006,
    },
  );

  const preview = previewService.buildPreview(result.resolvedFlow, result.manifest, result.warnings);
  const data = result.transaction.getData();
  const calls = data.commands.filter((command) => command.$kind === 'MoveCall');
  const place = calls.find((command) => command.MoveCall.function === 'place_limit_order');
  const objectIds = data.inputs.flatMap((input) => {
    if (input.$kind === 'UnresolvedObject') return [input.UnresolvedObject.objectId];
    return [];
  });

  // The preview is now rendered from the manifest decoded back out of the compiled PTB, so it
  // can only report values that are actually in the bytes. Runtime values reach the bytes; the
  // stale stored config reaches neither the bytes nor the preview.
  const placeCall = result.manifest.find((c) => c.target.endsWith('::place_limit_order'))!;
  expect(placeCall).toBeDefined();
  expect(placeCall.u64Args).toContain('22'); // clientOrderId, from runtime
  expect(placeCall.u64Args).toContain('1250000'); // price 1.25, scaled, from runtime
  expect(placeCall.u64Args).toContain('10000000'); // quantity 0.01, scaled, from runtime
  expect(placeCall.u64Args).not.toContain('11'); // stale clientOrderId
  expect(placeCall.u64Args).not.toContain('99000000'); // stale price 99
  expect(placeCall.u64Args).not.toContain('99000000000'); // stale quantity 99
  expect(preview).toContain(placeCall.target);
  expect(preview).toContain(`amounts=[${placeCall.u64Args.join(', ')}]`);
  // Node config never reaches the preview: no config-rendered values, stale or fresh.
  expect(preview).not.toContain('price: 99');
  expect(preview).not.toContain('price: 1.25');
  expect(preview).not.toContain('DEEP_SUI');
  expect(objectIds).toContain(runtimeManager);
  expect(objectIds).toContain(runtimeTradeCap);
  expect(objectIds).toContain(pools[runtimePoolKey].address);
  expect(objectIds).not.toContain(staleManager);
  expect(objectIds).not.toContain(pools.DEEP_SUI.address);
  expect(place).toBeDefined();
  expect(inputU64(result.transaction, place!.MoveCall.arguments[3])).toBe(22n);
  expect(inputU64(result.transaction, place!.MoveCall.arguments[6])).toBe(1_250_000n);
  expect(inputU64(result.transaction, place!.MoveCall.arguments[7])).toBe(10_000_000n);
  expect(inputBool(result.transaction, place!.MoveCall.arguments[8])).toBe(false);
  expect(inputBool(result.transaction, place!.MoveCall.arguments[9])).toBe(false);
});
