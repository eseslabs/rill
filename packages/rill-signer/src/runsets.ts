import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalSignerPolicy } from './policy';

export interface RunSet extends LocalSignerPolicy {
  label: string;
}

export function runSetsDir(): string {
  return join(process.env.RILL_CONFIG_DIR ?? process.cwd(), '.rill', 'runsets');
}

export function runSetPath(label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(runSetsDir(), `${safe}.json`);
}

export function listRunSets(network?: string): RunSet[] {
  const dir = runSetsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  return files.flatMap((name) => {
    const raw = readFileSync(join(dir, name), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRunSet(parsed)) return [];
    if (network && parsed.network !== network) return [];
    return [parsed];
  });
}

export function saveRunSet(label: string, data: RunSet): RunSet {
  const dir = runSetsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = runSetPath(label);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return data;
}

function isRunSet(value: unknown): value is RunSet {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === 'string' &&
    typeof record.label === 'string' &&
    typeof record.actionId === 'string' &&
    typeof record.network === 'string' &&
    typeof record.sender === 'string' &&
    typeof record.walletPackageId === 'string' &&
    typeof record.walletId === 'string' &&
    typeof record.agentCapId === 'string' &&
    typeof record.balanceManagerId === 'string' &&
    typeof record.tradeCapId === 'string' &&
    typeof record.poolId === 'string' &&
    typeof record.maxAmountMist === 'string' &&
    typeof record.minimumRemainingMist === 'string'
  );
}
