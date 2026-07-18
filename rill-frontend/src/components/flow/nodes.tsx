import { memo, useCallback, useContext } from "react";
import { Handle, Position, type NodeProps, useReactFlow } from "reactflow";
import { motion } from "framer-motion";
import { Shield, Layers, FileCode2, MessageSquareText, Plug, List, Zap } from "lucide-react";
import { RillMark } from "@/components/rill-mark";
import type { Port } from "@/lib/rill-types";
import { FlowInLabels, FlowOutLabels, NodePort } from "@/components/flow/aligned-handle";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import { WIRE_IN, WIRE_OUT } from "@/lib/wire-inference";
import { isGuardrailMinValueValid } from "@/lib/publish-gate";
import {
  defaultActionConfig,
  otherSwapToken,
  type ActionConfig,
  type SwapTokenSymbol,
} from "@/lib/action-config";
import { TokenBadge, TokenSelect } from "@/components/flow/token-select";
import { ManifestContext } from "@/lib/manifest-context";
import { boundedByCaps, type CapabilityDeclarationCap } from "@/lib/capabilities";

export type ActionNodeData = {
  protocol: string;
  protocolId: string;
  actionId?: string;
  action: string;
  description: string;
  color: "mint" | "peach" | "sky" | "lilac";
  inputs: { key: string; label: string; type: string }[];
  config?: ActionConfig;
  ports?: { inputs: Port[]; outputs: Port[] };
  discovered?: boolean;
  module?: string;
};

const colorMap: Record<string, { bg: string; text: string; dot: string }> = {
  mint: { bg: "bg-mint", text: "text-mint-foreground", dot: "bg-mint-foreground" },
  peach: { bg: "bg-peach", text: "text-peach-foreground", dot: "bg-peach-foreground" },
  sky: { bg: "bg-sky", text: "text-sky-foreground", dot: "bg-sky-foreground" },
  lilac: { bg: "bg-lilac", text: "text-lilac-foreground", dot: "bg-lilac-foreground" },
};

const roleBadge: Partial<Record<NonNullable<Port["role"]>, string>> = {
  amount_in: "bg-mint/60 text-mint-foreground",
  amount_out: "bg-peach/60 text-peach-foreground",
  token_in: "bg-mint/60 text-mint-foreground",
  token_out: "bg-peach/60 text-peach-foreground",
  min_out: "bg-sky/60 text-sky-foreground",
  recipient: "bg-lilac/60 text-lilac-foreground",
  event: "bg-foreground/10 text-foreground/80",
  id: "bg-muted text-muted-foreground",
};

function ActionNodeImpl({ id, data, selected }: NodeProps<ActionNodeData>) {
  const c = colorMap[data.color] ?? colorMap.mint;
  const ports = data.ports;
  const { setNodes } = useReactFlow();
  const manifest = useContext(ManifestContext);

  const patchConfig = useCallback(
    (patch: ActionConfig) => {
      setNodes((nodes) =>
        nodes.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...(n.data as ActionNodeData),
                  config: { ...(data.config ?? {}), ...patch },
                },
              }
            : n,
        ),
      );
    },
    [id, data.config, setNodes],
  );

  const isCetusSwap = data.protocolId === "cetus" && data.action.toLowerCase().includes("swap");
  const isHaedalStake = data.protocolId === "haedal" && data.action.toLowerCase().includes("stake");
  const isDeepbookLimit =
    data.protocolId === "deepbook" && data.action.toLowerCase().includes("limit");
  const showPortGrid = ports && !isCetusSwap && !isHaedalStake && !isDeepbookLimit;
  const cfg: ActionConfig = {
    ...defaultActionConfig(
      data.protocolId,
      data.actionId ??
        (isCetusSwap ? "swap" : isHaedalStake ? "stake" : isDeepbookLimit ? "limit_order" : ""),
    ),
    ...data.config,
  };

  // Part B: neither node type has an editable Amount field anymore — the agent supplies the real
  // amount at runtime via MCP, bounded by the wallet's CapabilityManifest. `boundedByCaps` pulls
  // just the on-chain spend caps (+ the pre-flight slippage floor for a swap) into the "Bounded
  // by" panel below.
  const boundedCaps = isCetusSwap
    ? boundedByCaps(manifest, { includeSlippageFloor: true })
    : isHaedalStake
      ? boundedByCaps(manifest)
      : [];

  const fieldCls =
    "nodrag nowheel w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/40";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className={`relative min-w-[260px] overflow-visible rounded-2xl bg-card border border-border/70 shadow-[var(--shadow-soft)] ${
        selected ? "ring-2 ring-primary/60" : ""
      }`}
    >
      <div
        className={`px-3 py-2 rounded-t-2xl ${c.bg} ${c.text} flex items-center justify-between gap-2`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ProtocolLogo
            protocolId={data.protocolId}
            name={data.protocol}
            className="h-5 w-5 ring-background/40"
          />
          <span className="text-[11px] font-semibold uppercase tracking-wider truncate">
            {data.protocol}
          </span>
          {data.module && (
            <span className="text-[10px] font-mono opacity-70 truncate">::{data.module}</span>
          )}
        </div>
        {data.discovered && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-background/40 rounded-full px-1.5 py-0.5">
            <FileCode2 className="h-2.5 w-2.5" /> ABI
          </span>
        )}
      </div>

      <NodePort id={WIRE_IN} type="target" side="left">
        <FlowInLabels />
      </NodePort>

      <div className="px-3 py-3">
        <div className="text-sm font-semibold text-foreground">{data.action}</div>
        <div className="mt-0.5 text-xs text-muted-foreground leading-snug">{data.description}</div>

        {showPortGrid && ports && (
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <div className="space-y-1">
              {ports.inputs.map((p) => (
                <PortLabelRow key={p.key} port={p} align="left" />
              ))}
            </div>
            <div className="space-y-1">
              {ports.outputs.map((p) => (
                <PortLabelRow key={p.key} port={p} align="right" />
              ))}
            </div>
          </div>
        )}

        {isCetusSwap && (
          <div className="mt-3 space-y-2">
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Token in
              </span>
              <TokenSelect
                value={(cfg.tokenIn ?? "SUI") as SwapTokenSymbol}
                onChange={(tokenIn) => patchConfig({ tokenIn, tokenOut: otherSwapToken(tokenIn) })}
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Token out
              </span>
              <TokenSelect
                value={(cfg.tokenOut ?? "USDC") as SwapTokenSymbol}
                onChange={(tokenOut) =>
                  patchConfig({ tokenOut, tokenIn: otherSwapToken(tokenOut) })
                }
              />
            </label>
            <BoundedByPanel
              caps={boundedCaps}
              tokenSymbol={(cfg.tokenIn ?? "SUI") as SwapTokenSymbol}
            />
          </div>
        )}

        {isHaedalStake && (
          <div className="mt-3">
            <BoundedByPanel caps={boundedCaps} tokenSymbol="SUI" />
          </div>
        )}

        {isDeepbookLimit && (
          <div className="mt-3 space-y-2">
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Pool
              </span>
              <input
                className={fieldCls}
                value={cfg.poolKey ?? "SUI_DBUSDC"}
                onChange={(e) => patchConfig({ poolKey: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                BalanceManager
              </span>
              <input
                className={fieldCls}
                placeholder="0x…"
                value={cfg.balanceManagerId ?? ""}
                onChange={(e) => patchConfig({ balanceManagerId: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Price
                </span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className={fieldCls}
                  value={cfg.price ?? "1"}
                  onChange={(e) => patchConfig({ price: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Quantity
                </span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className={fieldCls}
                  value={cfg.quantity ?? "1"}
                  onChange={(e) => patchConfig({ quantity: e.target.value })}
                />
              </label>
            </div>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Deposit SUI
              </span>
              <input
                type="number"
                min="0"
                step="any"
                className={fieldCls}
                value={cfg.depositSui ?? "1.1"}
                onChange={(e) => patchConfig({ depositSui: e.target.value })}
              />
            </label>
          </div>
        )}

        {!isCetusSwap && !isHaedalStake && !isDeepbookLimit && data.inputs.length > 0 && (
          <div className="mt-2.5 space-y-1">
            {data.inputs.map((i) => (
              <div key={i.key} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{i.label}</span>
                <span className="font-mono text-foreground/80 bg-muted px-1.5 py-0.5 rounded">
                  {i.type}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <NodePort id={WIRE_OUT} type="source" side="right">
        <FlowOutLabels />
      </NodePort>
    </motion.div>
  );
}

/**
 * Part B: replaces the old manual Amount input on the Cetus swap / Haedal stake node bodies. The
 * agent supplies the real amount at runtime via MCP, bounded by whatever the wallet's
 * CapabilityManifest currently declares — this panel renders exactly those caps (read-only), so
 * the node stays honest about what actually bounds the agent instead of implying the studio-typed
 * number is what executes on-chain.
 */
function BoundedByPanel({
  caps,
  tokenSymbol,
}: {
  caps: CapabilityDeclarationCap[];
  tokenSymbol: SwapTokenSymbol;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Bounded by
        </span>
        <TokenBadge symbol={tokenSymbol} />
      </div>
      {caps.length === 0 ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          No spend cap yet — open Capabilities to bound the agent.
        </p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {caps.map((cap, i) => (
            <span
              key={`${cap.label}-${i}`}
              title={cap.enforcement === "on-chain" ? "Proved on-chain" : "Enforced pre-flight"}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  cap.enforcement === "on-chain" ? "bg-mint-foreground" : "bg-amber-500"
                }`}
              />
              {cap.label} <span className="font-mono text-muted-foreground">{cap.value}</span>
            </span>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-muted-foreground">Agent sets the amount at runtime.</p>
    </div>
  );
}

function PortLabelRow({ port, align }: { port: Port; align: "left" | "right" }) {
  return (
    <div className={`flex h-[22px] items-center gap-1.5 ${align === "right" ? "justify-end" : ""}`}>
      {align === "right" && (
        <span className="font-mono text-[10px] text-muted-foreground">{port.type}</span>
      )}
      <span
        className={`truncate font-medium ${roleBadge[port.role ?? "id"] ? "px-1.5 py-0.5 rounded " + roleBadge[port.role!] : "text-foreground/80"}`}
      >
        {port.label}
      </span>
      {align === "left" && (
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{port.type}</span>
      )}
    </div>
  );
}

export const ActionNode = memo(ActionNodeImpl);

function TriggerNodeImpl({ data }: NodeProps<{ label: string; sub: string }>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative min-w-[228px] overflow-visible rounded-2xl border border-border/70 bg-card shadow-[var(--shadow-soft)]"
    >
      <div className="flex items-center gap-2 rounded-t-2xl bg-gradient-to-r from-foreground to-foreground/85 px-3 py-2.5 text-background">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/15">
          <MessageSquareText className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider">Trigger</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-background/15 px-1.5 py-0.5 text-[9px] font-medium">
          <span className="h-1.5 w-1.5 rounded-full bg-mint" /> ready
        </span>
      </div>
      <div className="px-3 py-3">
        <div className="text-sm font-semibold text-foreground">{data.label}</div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{data.sub}</p>
      </div>
      <NodePort id={WIRE_OUT} type="source" side="right">
        <span className="text-muted-foreground">Start flow</span>
        <span className="ml-auto font-mono text-muted-foreground">flow out</span>
      </NodePort>
    </motion.div>
  );
}
export const TriggerNode = memo(TriggerNodeImpl);

/**
 * Part D: the deliberate endpoint of every flow — every canvas ends here, wired or not, so this
 * gets the most finished treatment of any node (soft primary ring on the card, header gradient
 * instead of a flat fill, a pulsing "connected" affordance) while leaving its handles/behavior
 * untouched. `tools/list`/`tools/call` render as crisp mono pills rather than plain filled blocks,
 * each carrying a small glyph that hints at its role (list = read, call = act) without claiming an
 * HTTP verb that doesn't apply to MCP's JSON-RPC methods.
 */
function OutputNodeImpl({ data }: NodeProps<{ label: string; sub: string }>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative min-w-[228px] overflow-visible rounded-2xl border border-primary/25 bg-card shadow-[var(--shadow-soft)] ring-1 ring-primary/10"
    >
      <div className="flex items-center gap-2 rounded-t-2xl bg-gradient-to-r from-primary to-primary/85 px-3 py-2.5 text-primary-foreground">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary-foreground/15">
          <Plug className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider">Output · MCP</span>
        <RillMark className="ml-auto h-3.5 w-3.5 opacity-80" />
      </div>
      <div className="px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">{data.label}</div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-mint/50 px-1.5 py-0.5 text-[9px] font-medium text-mint-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint-foreground/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-mint-foreground" />
            </span>
            connected
          </span>
        </div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{data.sub}</p>
        <div className="mt-3 flex flex-col items-start gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/60 px-2.5 py-1 text-[10px] font-mono font-medium text-foreground/75">
            <List className="h-3 w-3 text-muted-foreground" /> tools/list
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/[0.06] px-2.5 py-1 text-[10px] font-mono font-medium text-foreground/75">
            <Zap className="h-3 w-3 text-primary" /> tools/call
          </span>
        </div>
      </div>
      <NodePort
        id={WIRE_IN}
        type="target"
        side="left"
        placement="bottom"
        className="border-primary/20 bg-primary/[0.04]"
      >
        <FlowInLabels />
      </NodePort>
    </motion.div>
  );
}
export const OutputNode = memo(OutputNodeImpl);

export type PtbNodeData = { label: string; steps: number };
function PtbNodeImpl({ data }: NodeProps<PtbNodeData>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative rounded-2xl bg-card border border-dashed border-primary/60 px-3.5 py-3 min-w-[220px] shadow-[var(--shadow-soft)]"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Layers className="h-3.5 w-3.5" />
        </span>
        <div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">PTB</div>
          <div className="text-sm font-semibold">{data.label}</div>
        </div>
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Batched into one transaction · <span className="font-mono">{data.steps}</span> moves
      </div>
      <Handle id={WIRE_IN} type="target" position={Position.Left} className="flow-handle" />
      <Handle id={WIRE_OUT} type="source" position={Position.Right} className="flow-handle" />
    </motion.div>
  );
}
export const PtbNode = memo(PtbNodeImpl);

export type GuardrailNodeData = {
  rules: { id: string; label: string }[];
  minValue?: string;
  coinType?: string;
};
function GuardrailNodeImpl({ id, data, selected }: NodeProps<GuardrailNodeData>) {
  const { setNodes } = useReactFlow();
  const patch = useCallback(
    (patch: Partial<GuardrailNodeData>) => {
      setNodes((nodes) =>
        nodes.map((n) =>
          n.id === id ? { ...n, data: { ...(n.data as GuardrailNodeData), ...patch } } : n,
        ),
      );
    },
    [id, setNodes],
  );
  const fieldCls =
    "nodrag nowheel w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/40";
  const minValueValid = isGuardrailMinValueValid(data.minValue);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`relative rounded-2xl bg-card border border-border/70 px-3.5 py-3 min-w-[220px] shadow-[var(--shadow-soft)] ${
        selected ? "ring-2 ring-primary/60" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-peach text-peach-foreground">
          <Shield className="h-3.5 w-3.5" />
        </span>
        <div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Guardrail
          </div>
          <div className="text-sm font-semibold">Pre-flight checks</div>
        </div>
      </div>
      <ul className="mt-2 space-y-0.5">
        {data.rules.map((r) => (
          <li key={r.id} className="text-[11px] text-foreground/75 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {r.label}
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Min value (SUI)
          </span>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="Required — e.g. 0.05"
            className={`${fieldCls} ${!minValueValid ? "border-destructive focus:ring-destructive/40" : ""}`}
            value={data.minValue ?? ""}
            onChange={(e) => patch({ minValue: e.target.value })}
            aria-invalid={!minValueValid}
            aria-describedby={!minValueValid ? `guardrail-min-error-${id}` : undefined}
          />
          {!minValueValid && (
            <p id={`guardrail-min-error-${id}`} className="mt-1 text-[10px] text-destructive">
              Required — must be greater than 0, or this guardrail enforces nothing.
            </p>
          )}
        </label>
        <label className="block">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Coin type
          </span>
          <input
            className={fieldCls}
            value={data.coinType ?? "0x2::sui::SUI"}
            onChange={(e) => patch({ coinType: e.target.value })}
          />
        </label>
      </div>
      <Handle id={WIRE_IN} type="target" position={Position.Left} className="flow-handle" />
      <Handle id={WIRE_OUT} type="source" position={Position.Right} className="flow-handle" />
    </motion.div>
  );
}
export const GuardrailNode = memo(GuardrailNodeImpl);
