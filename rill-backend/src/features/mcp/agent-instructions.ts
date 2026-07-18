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

/** No-wallet honest state (KTD-6) — reused verbatim so every rendering surface says the same thing. */
export const NO_MANIFEST_DECLARATION =
  'This skill runs without an agent-wallet budget binding — no on-chain spend limit is enforced yet.';

function mcpUrlFor(skill: PublishedSkill): string {
  return `${config.publicBaseUrl}/api/mcp/${skill.id}`;
}

/** The two `claude mcp add` commands — the exact env-safe form from the README's "Use it with any
 *  agent" section: public network + policy-path values only travel through MCP config; the signer
 *  key is set only in the shell that launches the agent and is never written to config, arguments,
 *  or transcripts. */
function renderMcpAddCommands(skill: PublishedSkill): string[] {
  return [
    'Set the local signer key only in the shell or secret manager that launches the agent. Never put',
    'it in MCP JSON, command arguments, transcripts, or the repository.',
    '',
    '```bash',
    `export RILL_REMOTE_MCP_URL="${mcpUrlFor(skill)}"`,
    'claude mcp add --transport http rill-actions "$RILL_REMOTE_MCP_URL"',
    '```',
    '',
    '```bash',
    `export SUI_NETWORK="${config.network}"`,
    'export RILL_WALLET_MCP_ENTRY="<absolute path to this repo>/packages/rill-signer/src/mcp.ts"',
    'export RILL_SIGNER_POLICY_PATH="<absolute path to this repo>/.rill/demo/sets/live.json"',
    '',
    'claude mcp add --env "SUI_NETWORK=$SUI_NETWORK" --env "RILL_SIGNER_POLICY_PATH=$RILL_SIGNER_POLICY_PATH" --transport stdio rill-wallet -- bun run "$RILL_WALLET_MCP_ENTRY"',
    '```',
    '',
    'Launch the agent from the shell where `RILL_SUI_PRIVATE_KEY` is already set so the local signer',
    'inherits it without the value ever being written to MCP configuration.',
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
    `# Agent Instructions — ${skill.name}`,
    '',
    `Ready-to-paste onboarding for any MCP-capable agent (Claude Code, OpenClaw, Hermes, …) to use `
      + `this Rill skill: **${skill.name}** (\`${skill.id}\`), network **${config.network}**.`,
    '',
    '## 1. Connect the MCP servers',
    '',
    ...renderMcpAddCommands(skill),
    '',
    '## 2. Tool sequence',
    '',
    ...renderToolSequence(skill),
    '',
    '## 3. Active guardrails',
    '',
    ...renderGuardrails(manifest),
    '',
    '## 4. Example agent prompt',
    '',
    ...renderExamplePrompt(manifest),
    '',
  ].join('\n');
}
