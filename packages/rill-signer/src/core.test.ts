import { test, expect } from 'bun:test';
import { loadConfigFromEnv, createSigner, executePtb } from './core';

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

test('executePtb: no key → clear error, never signs', async () => {
  const cfg = loadConfigFromEnv({}); // no key
  const signer = createSigner(cfg);
  expect(signer.hasKey()).toBe(false);
  await expect(executePtb('AAAA', signer, cfg)).rejects.toThrow(/No key configured/);
});
