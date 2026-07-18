import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  loadConfigFromEnv,
  createSigner,
  executePtb,
  executeUnsafePtb,
  extractCreatedObjectId,
  signAndExecutePtb,
  type Signer,
} from './core';
import { keystorePath } from './keystore';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'rill-core-ks-')); }

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

test('executeUnsafePtb: no key registered for the signer → clear error, never signs', async () => {
  // A signer whose client was never produced by createSigner has no keypair in the module-private
  // WeakMap. This is distinct from "cfg had no secretKey" — since createSigner now always resolves a
  // keypair (env key or local keystore fallback), the only way to reach "no key" is a signer built
  // outside createSigner, which is what this exercises.
  const cfg = loadConfigFromEnv({});
  const signer: Signer = { address: undefined, network: 'testnet', client: {} as never, hasKey: () => false };
  await expect(executeUnsafePtb('AAAA', signer, cfg)).rejects.toThrow(/No key configured/);
});

test('createSigner: falls back to the local keystore when no secretKey is set', () => {
  const dir = tmpDir();
  try {
    const cfg = { ...loadConfigFromEnv({}), keystoreBaseDir: dir };
    const signer = createSigner(cfg);
    expect(signer.hasKey()).toBe(true);
    expect(signer.address).toMatch(/^0x[0-9a-f]{64}$/);
    expect(existsSync(keystorePath('testnet', dir))).toBe(true);

    // A second createSigner call (fresh cfg, same dir) reuses the persisted keypair.
    const cfg2 = { ...loadConfigFromEnv({}), keystoreBaseDir: dir };
    const signer2 = createSigner(cfg2);
    expect(signer2.address).toBe(signer.address);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSigner: an explicit secretKey still wins over the keystore', () => {
  const dir = tmpDir();
  try {
    const keypair = Ed25519Keypair.generate();
    const expectedAddress = keypair.getPublicKey().toSuiAddress();
    const cfg = { ...loadConfigFromEnv({ RILL_SUI_PRIVATE_KEY: keypair.getSecretKey() }), keystoreBaseDir: dir };
    const signer = createSigner(cfg);
    expect(signer.address).toBe(expectedAddress);
    // The keystore must never be touched when an env key is present.
    expect(existsSync(keystorePath('testnet', dir))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSigner: logs a one-line stderr notice when generating a new key, and never logs the secret', () => {
  const dir = tmpDir();
  const originalError = console.error;
  const lines: string[] = [];
  console.error = ((...args: unknown[]) => { lines.push(args.map(String).join(' ')); }) as typeof console.error;
  try {
    const cfg = { ...loadConfigFromEnv({}), keystoreBaseDir: dir };
    const signer = createSigner(cfg);
    expect(signer.address).toBeDefined();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(signer.address as string);
    expect(lines[0]).not.toMatch(/suiprivkey1/);

    // Reusing the same (already-created) key must NOT log again.
    const cfg2 = { ...loadConfigFromEnv({}), keystoreBaseDir: dir };
    createSigner(cfg2);
    expect(lines.length).toBe(1);
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
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
