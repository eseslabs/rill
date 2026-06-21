import { memo, useCallback, useRef } from "react";
import { Handle, Position, type NodeProps, useReactFlow } from "reactflow";
import { motion } from "framer-motion";
import { Shield, Layers, Sparkles } from "lucide-react";
import type { Port } from "@/lib/rill-types";
import { AlignedHandle, WireRow } from "@/components/flow/aligned-handle";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import {
  SWAP_TOKENS,
  defaultActionConfig,
  otherSwapToken,
  type ActionConfig,
  type SwapTokenSymbol,
} from "@/lib/action-config";

export type ActionNodeData = {
  protocol: string;
  protocolId: string;
  actionId?: string;
  action: string;
  description: string;
  color: "mint" | "peach" | "sky" | "lilac";
  /** Legacy field — kept for backwards compatibility with the older library nodes. */
  inputs: { key: string; label: string; type: string }[];
  /** User-editable values passed to the backend compiler. */
  config?: ActionConfig;
  /** New: typed/labeled ports surfaced by introspection. When present, the node
   * renders one handle per input on the left and one per output on the right. */
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
  const cetusFlowInRef = useRef<HTMLDivElement>(null);
  const cetusOutRef = useRef<HTMLDivElement>(null);
  const cetusFlowOutRef = useRef<HTMLDivElement>(null);
  const haedalInRef = useRef<HTMLDivElement>(null);
  const haedalFlowOutRef = useRef<HTMLDivElement>(null);

  const patchConfig = useCallback(
    (patch: ActionConfig) => {
      setNodes((nodes) =>
        nodes.map((n) =>
          n.id === id
            ? { ...n, data: { ...(n.data as ActionNodeData), config: { ...(data.config ?? {}), ...patch } } }
            : n,
        ),
      );
    },
    [id, data.config, setNodes],
  );

  const isCetusSwap = data.protocolId === "cetus" && data.action.toLowerCase().includes("swap");
  const isHaedalStake = data.protocolId === "haedal" && data.action.toLowerCase().includes("stake");
  const showPortGrid = ports && !isCetusSwap && !isHaedalStake;
  const cfg: ActionConfig = {
    ...defaultActionConfig(
      data.protocolId,
      data.actionId ?? (isCetusSwap ? "swap" : isHaedalStake ? "stake" : ""),
    ),
    ...data.config,
  };

  const fieldCls =
    "nodrag nowheel w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/40";
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={`relative min-w-[260px] rounded-2xl bg-card border border-border/70 shadow-[var(--shadow-soft)] ${
        selected ? "ring-2 ring-primary/60" : ""
      }`}
    >
      {!ports && !isCetusSwap && !isHaedalStake && (
        <Handle type="target" position={Position.Left} className="flow-handle" />
      )}
      <div className={`px-3 py-2 rounded-t-2xl ${c.bg} ${c.text} flex items-center justify-between gap-2`}>
        <div className="flex items-center gap-2 min-w-0">
          <ProtocolLogo protocolId={data.protocolId} name={data.protocol} className="h-5 w-5 ring-background/40" />
          <span className="text-[11px] font-semibold uppercase tracking-wider truncate">{data.protocol}</span>
          {data.module && (
            <span className="text-[10px] font-mono opacity-70 truncate">::{data.module}</span>
          )}
        </div>
        {data.discovered && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-background/40 rounded-full px-1.5 py-0.5">
            <Sparkles className="h-2.5 w-2.5" /> ABI
          </span>
        )}
      </div>
      <div className="px-3 py-3">
        <div className="text-sm font-semibold text-foreground">{data.action}</div>
        <div className="mt-0.5 text-xs text-muted-foreground leading-snug">{data.description}</div>

        {showPortGrid && ports && (
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <div className="space-y-1">
              {ports.inputs.map((p) => (
                <PortInputRow key={p.key} nodeId={id} port={p} />
              ))}
            </div>
            <div className="space-y-1">
              {ports.outputs.map((p) => (
                <PortOutputRow key={p.key} nodeId={id} port={p} />
              ))}
            </div>
          </div>
        )}

        {isCetusSwap ? (
          <div className="mt-3 space-y-2">
            <div
              ref={cetusFlowInRef}
              className="flex items-center gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/40 px-2.5 py-1.5"
            >
              <span className="text-[10px] text-muted-foreground">← Connect from Trigger</span>
            </div>
            <AlignedHandle
              id="in:flow"
              nodeId={id}
              type="target"
              position={Position.Left}
              alignRef={cetusFlowInRef}
            />
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Token in</span>
              <select
                className={`${fieldCls} mt-0.5`}
                value={cfg.tokenIn ?? "SUI"}
                onChange={(e) => {
                  const tokenIn = e.target.value as SwapTokenSymbol;
                  patchConfig({ tokenIn, tokenOut: otherSwapToken(tokenIn) });
                }}
              >
                {SWAP_TOKENS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Token out</span>
              <select
                className={`${fieldCls} mt-0.5`}
                value={cfg.tokenOut ?? "USDC"}
                onChange={(e) => {
                  const tokenOut = e.target.value as SwapTokenSymbol;
                  patchConfig({ tokenOut, tokenIn: otherSwapToken(tokenOut) });
                }}
              >
                {SWAP_TOKENS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Amount</span>
              <div className="mt-0.5 flex items-center gap-1.5">
                <input
                  type="number"
                  min="0.000000001"
                  step="any"
                  className={fieldCls}
                  value={cfg.amount ?? "0.1"}
                  onChange={(e) => patchConfig({ amount: e.target.value })}
                />
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">{cfg.tokenIn ?? "SUI"}</span>
              </div>
            </label>
            <WireRow
              nodeId={id}
              handleId="out:coin_out"
              handleType="source"
              handlePosition={Position.Right}
              className="border-peach/50 bg-peach/10 justify-between"
            >
              <span className="text-[10px] text-muted-foreground">Coin → Haedal stake</span>
              <span className="text-[10px] font-mono font-medium bg-peach/60 text-peach-foreground px-1.5 py-0.5 rounded">
                coin_out
              </span>
            </WireRow>
            <div
              ref={cetusFlowOutRef}
              className="flex items-center justify-end gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/40 px-2.5 py-1.5"
            >
              <span className="text-[10px] text-muted-foreground">Flow → MCP output</span>
              <span className="text-[10px] font-mono text-muted-foreground">→</span>
            </div>
            <AlignedHandle
              id="out:flow"
              nodeId={id}
              type="source"
              position={Position.Right}
              alignRef={cetusFlowOutRef}
            />
          </div>
        ) : isHaedalStake ? (
          <div className="mt-3 space-y-2">
            <WireRow
              nodeId={id}
              handleId="in:sui_coin"
              handleType="target"
              handlePosition={Position.Left}
              className="border-mint/50 bg-mint/10"
            >
              <span className="text-[10px] text-muted-foreground">
                ← <span className="font-mono font-medium text-foreground">coin_out</span> from Cetus
              </span>
              <span className="ml-auto text-[10px] font-mono font-medium bg-mint/60 text-mint-foreground px-1.5 py-0.5 rounded">
                sui_coin
              </span>
            </WireRow>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Stake amount</span>
              <div className="mt-0.5 flex items-center gap-1.5">
                <input
                  type="number"
                  min="1"
                  step="any"
                  className={fieldCls}
                  value={cfg.amount ?? "1"}
                  onChange={(e) => patchConfig({ amount: e.target.value })}
                />
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">SUI</span>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">Minimum 1 SUI on testnet</p>
            </label>
            <div
              ref={haedalFlowOutRef}
              className="flex items-center justify-end gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/40 px-2.5 py-1.5"
            >
              <span className="text-[10px] text-muted-foreground">Flow → MCP output</span>
              <span className="text-[10px] font-mono text-muted-foreground">→</span>
            </div>
            <AlignedHandle
              id="out:flow"
              nodeId={id}
              type="source"
              position={Position.Right}
              alignRef={haedalFlowOutRef}
            />
          </div>
        ) : (
          data.inputs.length > 0 && (
            <div className="mt-2.5 space-y-1">
              {data.inputs.map((i) => (
                <div key={i.key} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{i.label}</span>
                  <span className="font-mono text-foreground/80 bg-muted px-1.5 py-0.5 rounded">{i.type}</span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
      {!ports && !isCetusSwap && !isHaedalStake && (
        <Handle type="source" position={Position.Right} className="flow-handle" />
      )}
    </motion.div>
  );
}

function PortInputRow({ nodeId, port }: { nodeId: string; port: Port }) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className="relative flex h-[22px] items-center gap-1.5">
      <AlignedHandle
        id={`in:${port.key}`}
        nodeId={nodeId}
        type="target"
        position={Position.Left}
        alignRef={rowRef}
      />
      <span
        className={`truncate font-medium ${roleBadge[port.role ?? "id"] ? "px-1.5 py-0.5 rounded " + roleBadge[port.role!] : "text-foreground/80"}`}
      >
        {port.label}
      </span>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{port.type}</span>
    </div>
  );
}

function PortOutputRow({ nodeId, port }: { nodeId: string; port: Port }) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className="relative flex h-[22px] items-center justify-end gap-1.5">
      <span className="font-mono text-[10px] text-muted-foreground">{port.type}</span>
      <span
        className={`truncate font-medium ${roleBadge[port.role ?? "id"] ? "px-1.5 py-0.5 rounded " + roleBadge[port.role!] : "text-foreground/80"}`}
      >
        {port.label}
      </span>
      <AlignedHandle
        id={`out:${port.key}`}
        nodeId={nodeId}
        type="source"
        position={Position.Right}
        alignRef={rowRef}
      />
    </div>
  );
}

export const ActionNode = memo(ActionNodeImpl);

function TriggerNodeImpl({ data }: NodeProps<{ label: string; sub: string }>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="relative rounded-2xl bg-foreground text-background px-4 py-3 shadow-[var(--shadow-float)] min-w-[200px]"
    >
      <div className="text-[11px] uppercase tracking-widest opacity-60">Trigger</div>
      <div className="mt-0.5 text-sm font-semibold">{data.label}</div>
      <div className="text-xs opacity-70">{data.sub}</div>
      <Handle id="out:flow" type="source" position={Position.Right} className="flow-handle" />
    </motion.div>
  );
}
export const TriggerNode = memo(TriggerNodeImpl);

function OutputNodeImpl({ data }: NodeProps<{ label: string; sub: string }>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="relative rounded-2xl bg-primary text-primary-foreground px-4 py-3 shadow-[var(--shadow-float)] min-w-[200px]"
    >
      <div className="text-[11px] uppercase tracking-widest opacity-70">Output</div>
      <div className="mt-0.5 text-sm font-semibold">{data.label}</div>
      <div className="text-xs opacity-80">{data.sub}</div>
      <Handle id="in:flow" type="target" position={Position.Left} className="flow-handle" />
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
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </motion.div>
  );
}
export const PtbNode = memo(PtbNodeImpl);

export type GuardrailNodeData = { rules: { id: string; label: string }[] };
function GuardrailNodeImpl({ data }: NodeProps<GuardrailNodeData>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative rounded-2xl bg-card border border-border/70 px-3.5 py-3 min-w-[220px] shadow-[var(--shadow-soft)]"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-peach text-peach-foreground">
          <Shield className="h-3.5 w-3.5" />
        </span>
        <div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Guardrail</div>
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
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </motion.div>
  );
}
export const GuardrailNode = memo(GuardrailNodeImpl);
