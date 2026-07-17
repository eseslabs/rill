import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OnboardingConfig {
  autoCreateRunSets: boolean;
  maxAutoSetupBudgetMist: string;
  allowTestnetFaucet: boolean;
}

const DEFAULT_CONFIG: OnboardingConfig = {
  autoCreateRunSets: false,
  maxAutoSetupBudgetMist: '2000000000',
  allowTestnetFaucet: true,
};

export function configDir(): string {
  return join(process.env.RILL_CONFIG_DIR ?? process.cwd(), '.rill');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadOnboardingConfig(): OnboardingConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OnboardingConfig>;
  return {
    autoCreateRunSets: parsed.autoCreateRunSets ?? DEFAULT_CONFIG.autoCreateRunSets,
    maxAutoSetupBudgetMist: parsed.maxAutoSetupBudgetMist ?? DEFAULT_CONFIG.maxAutoSetupBudgetMist,
    allowTestnetFaucet: parsed.allowTestnetFaucet ?? DEFAULT_CONFIG.allowTestnetFaucet,
  };
}

export function saveOnboardingConfig(config: Partial<OnboardingConfig>): OnboardingConfig {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = loadOnboardingConfig();
  const next: OnboardingConfig = { ...current, ...config };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n');
  return next;
}
