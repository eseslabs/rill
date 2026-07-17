import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadOnboardingConfig, saveOnboardingConfig } from './config';

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
    autoCreateRunSets: false,
    maxAutoSetupBudgetMist: '2000000000',
    allowTestnetFaucet: true,
  });
});

test('saveOnboardingConfig creates the config file and merges partial updates', () => {
  saveOnboardingConfig({ autoCreateRunSets: true });
  expect(existsSync(configPath())).toBe(true);
  expect(loadOnboardingConfig()).toEqual({
    autoCreateRunSets: true,
    maxAutoSetupBudgetMist: '2000000000',
    allowTestnetFaucet: true,
  });

  saveOnboardingConfig({ maxAutoSetupBudgetMist: '500000000' });
  expect(loadOnboardingConfig()).toEqual({
    autoCreateRunSets: true,
    maxAutoSetupBudgetMist: '500000000',
    allowTestnetFaucet: true,
  });
});
