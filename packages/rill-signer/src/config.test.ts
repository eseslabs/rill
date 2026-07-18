import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadOnboardingConfig, saveOnboardingConfig, isAutoOnboardingAllowed, loadCustodyMode } from './config';

let originalConfigDir: string | undefined;
let tempConfigDir: string;

beforeEach(() => {
  originalConfigDir = process.env.RILL_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), 'rill-config-test-'));
  process.env.RILL_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RILL_CONFIG_DIR;
  else process.env.RILL_CONFIG_DIR = originalConfigDir;
  rmSync(tempConfigDir, { recursive: true, force: true });
});

test('loadOnboardingConfig returns defaults when config file is missing', () => {
  expect(loadOnboardingConfig()).toEqual({
    maxAutoSetupBudgetMist: '2000000000',
    allowTestnetFaucet: true,
  });
});

test('saveOnboardingConfig creates the config file and merges partial updates', () => {
  saveOnboardingConfig({ maxAutoSetupBudgetMist: '500000000' });
  expect(existsSync(configPath())).toBe(true);
  expect(loadOnboardingConfig()).toEqual({
    maxAutoSetupBudgetMist: '500000000',
    allowTestnetFaucet: true,
  });

  saveOnboardingConfig({ allowTestnetFaucet: false });
  expect(loadOnboardingConfig()).toEqual({
    maxAutoSetupBudgetMist: '500000000',
    allowTestnetFaucet: false,
  });
});

test('saveOnboardingConfig has no field for autoCreateRunSets: persisted config can never enable auto onboarding', () => {
  // A stray/hostile caller passing autoCreateRunSets must not get it persisted — saveOnboardingConfig
  // reads out only the two known fields by name rather than spreading its input.
  const hostileInput = { autoCreateRunSets: true, maxAutoSetupBudgetMist: '1' } as unknown as Partial<{
    maxAutoSetupBudgetMist: string;
    allowTestnetFaucet: boolean;
  }>;
  const saved = saveOnboardingConfig(hostileInput);
  expect(saved).not.toHaveProperty('autoCreateRunSets');
  expect(JSON.parse(readFileSync(configPath(), 'utf8'))).not.toHaveProperty('autoCreateRunSets');
  expect(isAutoOnboardingAllowed({})).toBe(false);
});

test('isAutoOnboardingAllowed is fail-closed: only the exact string "true" enables it', () => {
  expect(isAutoOnboardingAllowed({})).toBe(false);
  expect(isAutoOnboardingAllowed({ RILL_ALLOW_AUTO_ONBOARDING: undefined })).toBe(false);
  expect(isAutoOnboardingAllowed({ RILL_ALLOW_AUTO_ONBOARDING: 'false' })).toBe(false);
  expect(isAutoOnboardingAllowed({ RILL_ALLOW_AUTO_ONBOARDING: 'TRUE' })).toBe(false);
  expect(isAutoOnboardingAllowed({ RILL_ALLOW_AUTO_ONBOARDING: '1' })).toBe(false);
  expect(isAutoOnboardingAllowed({ RILL_ALLOW_AUTO_ONBOARDING: 'yes' })).toBe(false);
  expect(isAutoOnboardingAllowed({ RILL_ALLOW_AUTO_ONBOARDING: ' true' })).toBe(false);
  expect(isAutoOnboardingAllowed({ RILL_ALLOW_AUTO_ONBOARDING: 'true' })).toBe(true);
});

test('isAutoOnboardingAllowed defaults to reading process.env', () => {
  const original = process.env.RILL_ALLOW_AUTO_ONBOARDING;
  try {
    delete process.env.RILL_ALLOW_AUTO_ONBOARDING;
    expect(isAutoOnboardingAllowed()).toBe(false);
    process.env.RILL_ALLOW_AUTO_ONBOARDING = 'true';
    expect(isAutoOnboardingAllowed()).toBe(true);
  } finally {
    if (original === undefined) delete process.env.RILL_ALLOW_AUTO_ONBOARDING;
    else process.env.RILL_ALLOW_AUTO_ONBOARDING = original;
  }
});

test('loadCustodyMode defaults to bounded when RILL_CUSTODY_MODE is unset', () => {
  expect(loadCustodyMode({})).toBe('bounded');
});

test('loadCustodyMode returns direct only for the exact string "direct"', () => {
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: 'direct' })).toBe('direct');
});

test('loadCustodyMode fails safe to bounded for any non-exact value: this is a security property', () => {
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: 'DIRECT' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: 'Direct' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: '1' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: 'true' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: ' direct' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: 'direct ' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: 'bounded' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: '' })).toBe('bounded');
  expect(loadCustodyMode({ RILL_CUSTODY_MODE: undefined })).toBe('bounded');
});

test('loadCustodyMode defaults to reading process.env', () => {
  const original = process.env.RILL_CUSTODY_MODE;
  try {
    delete process.env.RILL_CUSTODY_MODE;
    expect(loadCustodyMode()).toBe('bounded');
    process.env.RILL_CUSTODY_MODE = 'direct';
    expect(loadCustodyMode()).toBe('direct');
  } finally {
    if (original === undefined) delete process.env.RILL_CUSTODY_MODE;
    else process.env.RILL_CUSTODY_MODE = original;
  }
});
