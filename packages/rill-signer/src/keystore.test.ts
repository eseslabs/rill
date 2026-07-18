import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKeypair, keystorePath } from './keystore';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'rill-ks-')); }

test('generates and persists a keypair on first call', () => {
  const dir = tmpDir();
  try {
    const { keypair, created } = loadOrCreateKeypair('testnet', dir);
    expect(created).toBe(true);
    expect(keypair.getPublicKey().toSuiAddress()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(existsSync(keystorePath('testnet', dir))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a second call loads the SAME keypair (no regeneration)', () => {
  const dir = tmpDir();
  try {
    const first = loadOrCreateKeypair('testnet', dir);
    const second = loadOrCreateKeypair('testnet', dir);
    expect(second.created).toBe(false);
    expect(second.keypair.getPublicKey().toSuiAddress()).toBe(first.keypair.getPublicKey().toSuiAddress());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the key file is written 0600 (owner-only)', () => {
  const dir = tmpDir();
  try {
    loadOrCreateKeypair('testnet', dir);
    const mode = statSync(keystorePath('testnet', dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('testnet and mainnet keys are stored separately', () => {
  const dir = tmpDir();
  try {
    const t = loadOrCreateKeypair('testnet', dir);
    const m = loadOrCreateKeypair('mainnet', dir);
    expect(t.keypair.getPublicKey().toSuiAddress()).not.toBe(m.keypair.getPublicKey().toSuiAddress());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
