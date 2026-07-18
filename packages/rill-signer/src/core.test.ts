import { test, expect } from 'bun:test';
import { loadConfigFromEnv, createSigner, executePtb, executeUnsafePtb, extractCreatedObjectId, signAndExecutePtb } from './core';

test('loadConfigFromEnv: defaults + key aliasing + mainnet guard parsing', () => {
  const a = loadConfigFromEnv({ SUI_PRIVATE_KEY: 'suiprivkey1xxx' });
  expect(a.network).toBe('testnet');
  expect(a.secretKey).toBe('suiprivkey1xxx');
  expect(a.allowMainnet).toBe(false);
  expect(a.requireSimSuccess).toBe(true);

  const b = loadConfigFromEnv({
    RILL_SUI_PRIVATE_KEY: 'primary',
    SUI_PRIVATE_KEY: 'fallback',
    SUI_NETWORK: 'mainnet',
    RILL_ALLOW_MAINNET: 'true',
    RILL_MAX_GAS_MIST: '50000000',
  });
  expect(b.secretKey).toBe('primary'); // RILL_ prefix wins
  expect(b.network).toBe('mainnet');
  expect(b.allowMainnet).toBe(true);
  expect(b.maxGasBudgetMist).toBe(50000000n);
});

test('executeUnsafePtb: no key → clear error, never signs', async () => {
  const cfg = loadConfigFromEnv({}); // no key
  const signer = createSigner(cfg);
  expect(signer.hasKey()).toBe(false);
  await expect(executeUnsafePtb('AAAA', signer, cfg)).rejects.toThrow(/No key configured/);
});

test('legacy raw MCP entry point is disabled', async () => {
  await expect(executePtb('AAAA', {} as never, {} as never)).rejects.toThrow('Raw PTB execution is disabled');
});

test('extractCreatedObjectId finds the created object by type suffix', () => {
  const result = {
    effects: {
      changedObjects: [
        { objectId: '0x1000000000000000000000000000000000000000000000000000000000000000', idOperation: 'Created' },
        { objectId: '0x2000000000000000000000000000000000000000000000000000000000000000', idOperation: 'Created' },
      ],
    },
    objectTypes: {
      '0x1000000000000000000000000000000000000000000000000000000000000000': '0x2::agent_wallet::AgentWallet',
      '0x2000000000000000000000000000000000000000000000000000000000000000': '0x2::balance_manager::BalanceManager',
    },
  };
  expect(extractCreatedObjectId(result, '::agent_wallet::AgentWallet')).toBe(
    '0x1000000000000000000000000000000000000000000000000000000000000000',
  );
});

test('extractCreatedObjectId throws when the created object is not found', () => {
  expect(() => extractCreatedObjectId({ effects: { changedObjects: [] }, objectTypes: {} }, '::agent_wallet::AgentWallet')).toThrow(
    /Created .* object not found/,
  );
});
