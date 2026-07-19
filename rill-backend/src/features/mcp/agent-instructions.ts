import { config } from '../../core/config';
import type { CapabilityManifest } from '../../../../packages/rill-sdk/src/capability-manifest';
import { toDeclaration } from '../../../../packages/rill-sdk/src/capability-manifest';
import type { PublishedSkill } from './skills.store';
import { actionTools } from './mcp.service';

/**
 * Task 4 (R10, R6-declaration-side): a ready-to-paste agent-instructions template per published
 * skill. This is a DECLARATION only — the third projection of the `CapabilityManifest`
 * (`toDeclaration`, `packages/rill-sdk/src/capability-manifest.ts`), never an enforcement layer.
 * An agent that ignores this file is still bounded by the on-chain `SpendPolicy` rules (projection
 * 1) and the signer's pre-flight mirror (projection 2); this document only tells a well-behaved
 * agent what those bounds are so it doesn't need to hallucinate them.
 *
 * KTD-6 (honest-behavior default): a skill with no `CapabilityManifest` renders the honest
 * no-wallet-budget state, never an aspirational "trust me" default.
 */

/**
 * The local `rill-wallet` MCP server's execution tool (`packages/rill-signer/src/mcp.ts`). Named
 * here as a literal — same convention `skill-doc.ts` already uses — rather than imported from the
 * signer package, so `features/mcp/` stays at zero coupling to Fajar's live signer files (KTD-5).
 */
const EXECUTE_TOOL_NAME = 'execute_rill_action';

/** The local `rill-wallet` tools this document references for one-time signer setup — real tools
 *  registered in `packages/rill-signer/src/mcp.ts`'s `walletTools` (`signer_status`,
 *  `request_faucet`), same zero-coupling literal convention as `EXECUTE_TOOL_NAME` above. */
const SIGNER_STATUS_TOOL_NAME = 'signer_status';
const REQUEST_FAUCET_TOOL_NAME = 'request_faucet';
const CREATE_RUN_SET_TOOL_NAME = 'create_run_set';

/** Release asset base for the standalone `rill-wallet` binary — a user installs the signer from
 *  here with one curl, no repo clone / bun / node. */
const RILL_WALLET_RELEASE_BASE =
  'https://github.com/eseslabs/rill/releases/latest/download';

/** No-wallet honest state (KTD-6) — reused verbatim so every rendering surface says the same thing. */
export const NO_MANIFEST_DECLARATION =
  'This skill runs without an agent-wallet budget binding — no on-chain spend limit is enforced yet.';

function mcpUrlFor(skill: PublishedSkill): string {
  return `${config.publicBaseUrl}/api/mcp/${skill.id}`;
}

/** Install the standalone signer binary + connect BOTH MCP servers, for Claude Code AND OpenCode —
 *  the agent runs these itself; the user runs nothing but the one restart. No key export (the signer
 *  auto-generates its own keypair on first use), no repo clone (hosted binary), no
 *  RILL_SIGNER_POLICY_PATH (create_run_set bootstraps the run-set). */
function renderConnectServers(skill: PublishedSkill): string[] {
  const url = mcpUrlFor(skill);
  const net = config.network;
  return [
    '**a. Install the local signer** (one standalone binary — no repo clone, no bun/node). Pick the OS:',
    '',
    '```bash',
    `curl -fsSL ${RILL_WALLET_RELEASE_BASE}/rill-wallet-darwin-arm64 -o rill-wallet && chmod +x rill-wallet`,
    '#   Intel Mac: rill-wallet-darwin-x64   ·   Linux: rill-wallet-linux-x64',
    '```',
    '',
    'No key to export — the signer generates and persists its own keypair on first use.',
    '',
    '**b. Connect both MCP servers.** Claude Code:',
    '',
    '```bash',
    `claude mcp add --transport http rill-actions "${url}"`,
    `claude mcp add --env "SUI_NETWORK=${net}" --transport stdio rill-wallet -- "$PWD/rill-wallet"`,
    '```',
    '',
    'OpenCode — add to `opencode.json` in the project root:',
    '',
    '```json',
    '{',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "mcp": {',
    `    "rill-actions": { "type": "remote", "url": "${url}", "enabled": true },`,
    `    "rill-wallet": { "type": "local", "command": ["./rill-wallet"], "environment": { "SUI_NETWORK": "${net}" }, "enabled": true }`,
    '  }',
    '}',
    '```',
    '',
    '**c. Fully restart the agent** (quit + relaunch in this directory) so the new MCP tools load —',
    'MCP servers are read once at startup, never mid-session.',
  ];
}

/** The correct tool sequence, pulled from the actual tool registries so this can never drift from
 *  what the servers expose: `list_actions`/`describe_action` from the remote `actionTools`
 *  registry (`mcp.service.ts`), `build_action` from the skill's own `toolDefs` (`tool-schema.ts`
 *  via `skills.store.ts`), and the local signer's `execute_rill_action`. */
function toolSequence(skill: PublishedSkill): readonly [string, string, string, string] {
  const [listActions, describeAction] = actionTools;
  return [listActions.name, describeAction.name, skill.toolDefs.name, EXECUTE_TOOL_NAME] as const;
}

/**
 * One-time local signer setup: how the agent gets a Sui address to build with, and how it funds
 * that address — the piece the old `packages/rill-signer/SKILL.md` covered (manual
 * `RILL_SUI_PRIVATE_KEY`) that regressed out of this generated doc. Verified against the CURRENT
 * signer (`packages/rill-signer/src/keystore.ts`'s `loadOrCreateKeypair`, `src/core.ts`'s
 * `resolveSignerKeypair`) rather than the old SKILL.md's env-var-only story: today, an explicit
 * `RILL_SUI_PRIVATE_KEY`/`SUI_PRIVATE_KEY` still wins when set, but absent either one the local
 * signer generates and persists its OWN keypair on first use — no manual key setup is required to
 * get started. Named tools (`signer_status`, `request_faucet`) are real entries in
 * `packages/rill-signer/src/mcp.ts`'s `walletTools`, not invented.
 */
function renderOnboard(): string[] {
  return [
    'Once the tools are loaded, the agent onboards the wallet on its own — the user only funds an',
    'address it hands back:',
    '',
    `1. \`${SIGNER_STATUS_TOOL_NAME}\` (local \`rill-wallet\`) — read the signer address, network, and`,
    '   SUI balance. Use that address as `sender` on every build call.',
    `2. \`${REQUEST_FAUCET_TOOL_NAME}\` (local, testnet) to fund gas — or tell the user in plain words:`,
    '   "Send some testnet SUI to `<address>`." (Mainnet: the user funds it.)',
    `3. \`${CREATE_RUN_SET_TOOL_NAME}\` (local) — confirm with the user, then create the bounded on-chain`,
    '   agent wallet + run-set. This wallet\'s budget is what actually bounds every spend.',
    '4. Report the address back and confirm it is funded and ready — then the user just prompts.',
  ];
}

function renderToolSequence(skill: PublishedSkill): string[] {
  const [listActions, describeAction, buildAction, executeAction] = toolSequence(skill);
  return [
    'Call tools strictly in this order:',
    '',
    `1. \`${listActions}\` (remote \`rill-actions\`) — discover this skill.`,
    `2. \`${describeAction}\` (remote \`rill-actions\`) — read parameters, wallet binding, and the strict-simulation rule.`,
    `3. \`${buildAction}\` (remote \`rill-actions\`) — compile and strictly simulate; returns an unsigned`,
    '   ExecutionEnvelope (Rill Cloud never signs).',
    `4. \`${executeAction}\` (local \`rill-wallet\`) — validate the envelope against the run-set policy,`,
    '   re-simulate, sign, and submit. Only this local tool ever produces a signature.',
  ];
}

/** Renders the active-guardrails section from `toDeclaration`'s summary lines + caps — or, absent
 *  a manifest, the honest no-wallet-budget state (KTD-6). Declares exactly what's active; no
 *  aspirational claims. */
function renderGuardrails(manifest: CapabilityManifest | undefined): string[] {
  if (!manifest) {
    return [
      NO_MANIFEST_DECLARATION,
      '',
      'Ask the wallet owner to attach a CapabilityManifest (budget, rate limit, protocol scope, …) ',
      'before running this skill unattended.',
    ];
  }

  const declaration = toDeclaration(manifest);
  const lines = [
    'This skill\'s agent wallet enforces the following, on-chain, by rules the agent cannot bypass:',
    '',
    ...declaration.summaryLines.map((line) => `- ${line}`),
    '',
    '| Guardrail | Value |',
    '|---|---|',
    ...declaration.caps.map((cap) => `| ${cap.label} | ${cap.value} |`),
  ];
  return lines;
}

function renderExamplePrompt(manifest: CapabilityManifest | undefined): string[] {
  const prompt = manifest
    ? 'Using the rill-actions and rill-wallet MCP servers, list the available action, describe it, '
      + 'then build and execute it within my declared wallet guardrails above. Stop and ask me before '
      + 'anything that would exceed them.'
    : 'Using the rill-actions and rill-wallet MCP servers, list the available action and describe it, '
      + 'then ask me to attach a wallet budget before building or executing anything — this skill has '
      + 'no on-chain spend limit yet.';
  return [`> "${prompt}"`];
}

/**
 * Renders a ready-to-paste Markdown agent-instructions document for a published skill: the two
 * `claude mcp add` commands, the correct tool sequence, the active guardrails declared honestly
 * from an (optional) `CapabilityManifest`, and an example bounded agent prompt.
 *
 * `manifest` is optional because `PublishedSkill` does not yet carry a manifest field — owner-set
 * manifest wiring is a later unit. Callers without one get the honest no-wallet-budget branch.
 */
export function renderAgentInstructions(skill: PublishedSkill, manifest?: CapabilityManifest): string {
  return [
    `# Set up & run — ${skill.name}`,
    '',
    `**Paste this whole file to your coding agent (Claude Code or OpenCode) and tell it to follow it.** `
      + `The agent installs the signer, connects the MCP servers, creates your bounded wallet, and hands `
      + `you an address to fund — then you just prompt. Nothing to hand-wire.`,
    '',
    `Skill: **${skill.name}** (\`${skill.id}\`), network **${config.network}**. Rill Cloud never signs — `
      + `it only builds; the local \`rill-wallet\` you install below holds the key and submits.`,
    '',
    '## 1. Agent: install & connect',
    '',
    ...renderConnectServers(skill),
    '',
    '## 2. Agent: onboard the wallet (after the restart)',
    '',
    ...renderOnboard(),
    '',
    '## 3. Agent: tool sequence for each request',
    '',
    ...renderToolSequence(skill),
    '',
    '## 4. Guardrails the wallet enforces on-chain',
    '',
    ...renderGuardrails(manifest),
    '',
    '## 5. Then you just prompt',
    '',
    ...renderExamplePrompt(manifest),
    '',
  ].join('\n');
}
