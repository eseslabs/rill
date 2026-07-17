import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Handle, Position, type NodeProps, useReactFlow, useEdges, useNodes } from "reactflow";
import { motion } from "framer-motion";
import { Shield, Layers, FileCode2, MessageSquareText, Plug, Wallet } from "lucide-react";
import { RillMark } from "@/components/rill-mark";
import type { Port } from "@/lib/rill-types";
import { FlowInLabels, FlowOutLabels, NodePort } from "@/components/flow/aligned-handle";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import { WIRE_IN, WIRE_OUT } from "@/lib/wire-inference";
import {
  defaultActionConfig,
  formatRawAmount,
  isA2B,
  otherSwapToken,
  toMist,
  toSlippageBps,
  DEEPBOOK_PAIRS,
  DEFAULT_SLIPPAGE_PCT,
  MAX_SLIPPAGE_PCT,
  TESTNET_MANIFEST,
  type ActionConfig,
  type SwapTokenSymbol,
  type DeepbookPairKey,
} from "@/lib/action-config";
import { rillApi, type Quote } from "@/lib/rill-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TokenBadge, TokenSelect } from "@/components/flow/token-select";

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

/**
 * Live spot quote for the swap node's current settings — advisory only.
 *
 * Shows the user the floor their slippage setting implies before they commit. The floor actually
 * asserted on chain is re-derived by the backend at compile time, so a stale or failed quote here
 * can never widen the real guard; it only means this readout goes quiet.
 */
function useSwapQuote(enabled: boolean, tokenIn: SwapTokenSymbol, amount: string, slippage: string) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amountIn = enabled ? toMist(amount, "0") : "0";
  const slippageBps = toSlippageBps(slippage);

  useEffect(() => {
    if (!enabled || amountIn === "0") {
      setQuote(null);
      setError(null);
      return;
    }
    let cancelled = false;
    // Debounced: the amount field fires this on every keystroke.
    const timer = setTimeout(() => {
      rillApi
        .quote({
          poolId: TESTNET_MANIFEST.cetus_swap.defaultPoolId,
          amountIn,
          a2b: isA2B(tokenIn),
          slippageBps,
        })
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setQuote(null);
          setError(err instanceof Error ? err.message : "Quote unavailable");
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, amountIn, slippageBps, tokenIn]);

  return { quote, error };
}

function ActionNodeImpl({ id, data, selected }: NodeProps<ActionNodeData>) {
  const c = colorMap[data.color] ?? colorMap.mint;
  const ports = data.ports;
  const { setNodes } = useReactFlow();
  const edges = useEdges();
  const nodes = useNodes();
  const incomingWallet = useMemo(() => {
    const walletEdge = edges.find((e) => e.target === id && e.source.startsWith("wallet_"));
    if (!walletEdge) return null;
    const walletNode = nodes.find((n) => n.id === walletEdge.source);
    return walletNode?.data as WalletNodeData | undefined;
  }, [edges, nodes, id]);

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
  const isDeepbookLimit =
    data.protocolId === "deepbook" && data.action.toLowerCase().includes("limit");
  const showPortGrid = ports && !isCetusSwap && !isHaedalStake && !isDeepbookLimit;
  const cfg: ActionConfig = {
    ...defaultActionConfig(
      data.protocolId,
      data.actionId ?? (isCetusSwap ? "swap" : isHaedalStake ? "stake" : isDeepbookLimit ? "limit_order" : ""),
    ),
    ...data.config,
  };

  const swapTokenIn = (cfg.tokenIn ?? "SUI") as SwapTokenSymbol;
  const { quote, error: quoteError } = useSwapQuote(
    isCetusSwap,
    swapTokenIn,
    String(cfg.amount ?? "0.1"),
    String(cfg.slippage ?? DEFAULT_SLIPPAGE_PCT),
  );

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
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Token in</span>
              <TokenSelect
                value={(cfg.tokenIn ?? "SUI") as SwapTokenSymbol}
                onChange={(tokenIn) => patchConfig({ tokenIn, tokenOut: otherSwapToken(tokenIn) })}
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Token out</span>
              <TokenSelect
                value={(cfg.tokenOut ?? "USDC") as SwapTokenSymbol}
                onChange={(tokenOut) => patchConfig({ tokenOut, tokenIn: otherSwapToken(tokenOut) })}
              />
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
                <TokenBadge symbol={swapTokenIn} />
              </div>
            </label>
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Max slippage
              </span>
              <div className="mt-0.5 flex items-center gap-1.5">
                <input
                  type="number"
                  min="0"
                  max={MAX_SLIPPAGE_PCT}
                  step="0.1"
                  className={fieldCls}
                  value={cfg.slippage ?? DEFAULT_SLIPPAGE_PCT}
                  onChange={(e) => patchConfig({ slippage: e.target.value })}
                />
                <span className="text-[11px] text-muted-foreground">%</span>
              </div>
            </label>

            <div className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
              {quote ? (
                <>
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-muted-foreground">Expected</span>
                    <span className="font-mono text-foreground">
                      ≈ {formatRawAmount(quote.expectedOut, otherSwapToken(swapTokenIn))}{" "}
                      {otherSwapToken(swapTokenIn)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-muted-foreground">Floor (on chain)</span>
                    <span className="font-mono text-foreground">
                      {formatRawAmount(quote.minAmountOut, otherSwapToken(swapTokenIn))}{" "}
                      {otherSwapToken(swapTokenIn)}
                    </span>
                  </div>
                  <p className="mt-1 text-[9px] leading-tight text-muted-foreground">
                    Spot price · ignores price impact. rill_guard aborts the swap below the floor.
                  </p>
                </>
              ) : quoteError ? (
                <p className="text-[10px] leading-tight text-muted-foreground">
                  No quote: {quoteError}. The floor is set at compile time — without a quote the
                  compile fails rather than swapping unguarded.
                </p>
              ) : (
                <p className="text-[10px] text-muted-foreground">Quoting…</p>
              )}
            </div>
          </div>
        )}

        {isHaedalStake && (
          <div className="mt-3">
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
                <TokenBadge symbol="SUI" />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">Minimum 1 SUI on testnet</p>
            </label>
          </div>
        )}

        {isDeepbookLimit && (
          <div className="mt-3 space-y-2">
            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Pair</span>
              <Select
                value={(cfg.poolKey as DeepbookPairKey) || "SUI_DBUSDC"}
                onValueChange={(v) => patchConfig({ poolKey: v })}
              >
                <SelectTrigger className="nodrag nowheel mt-0.5 h-8 w-full cursor-pointer bg-background text-[11px] shadow-none focus:ring-1 focus:ring-primary/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[200] cursor-pointer">
                  {DEEPBOOK_PAIRS.map((p) => (
                    <SelectItem
                      key={p.key}
                      value={p.key}
                      className="cursor-pointer py-2 pl-2 pr-8 text-[11px]"
                    >
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Price</span>
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
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Amount</span>
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

            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Side</span>
              <div className="mt-0.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => patchConfig({ isBid: "true" })}
                  className={`nodrag nowheel rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                    cfg.isBid === "true"
                      ? "border-mint bg-mint/20 text-mint-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => patchConfig({ isBid: "false" })}
                  className={`nodrag nowheel rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                    cfg.isBid !== "true"
                      ? "border-peach bg-peach/20 text-peach-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Sell
                </button>
              </div>
            </div>

            <label className="block">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Deposit SUI</span>
              <input
                type="number"
                min="0"
                step="any"
                className={fieldCls}
                value={cfg.depositSui ?? "1.1"}
                onChange={(e) => patchConfig({ depositSui: e.target.value })}
              />
            </label>

            {incomingWallet ? (
              <div className="rounded-lg border border-mint/30 bg-mint/10 px-2.5 py-1.5 text-[10px] text-mint-foreground">
                <span className="font-medium">Wallet connected</span>
                <div className="mt-0.5 truncate font-mono opacity-80">
                  {incomingWallet.walletId || "0x…"}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                Connect a Wallet node to supply BalanceManager & TradeCap.
              </div>
            )}
          </div>
        )}

        {!isCetusSwap && !isHaedalStake && !isDeepbookLimit && data.inputs.length > 0 && (
          <div className="mt-2.5 space-y-1">
            {data.inputs.map((i) => (
              <div key={i.key} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{i.label}</span>
                <span className="font-mono text-foreground/80 bg-muted px-1.5 py-0.5 rounded">{i.type}</span>
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

function PortLabelRow({ port, align }: { port: Port; align: "left" | "right" }) {
  return (
    <div
      className={`flex h-[22px] items-center gap-1.5 ${align === "right" ? "justify-end" : ""}`}
    >
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
      <div className="overflow-hidden rounded-t-2xl flex items-center gap-2 bg-foreground px-3 py-2 text-background">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/15">
          <MessageSquareText className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider">Trigger</span>
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

function OutputNodeImpl({ data }: NodeProps<{ label: string; sub: string }>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative min-w-[228px] overflow-visible rounded-2xl border border-border/70 bg-card shadow-[var(--shadow-soft)]"
    >
      <div className="overflow-hidden rounded-t-2xl flex items-center gap-2 bg-primary px-3 py-2 text-primary-foreground">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary-foreground/15">
          <Plug className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider">Output · MCP</span>
        <RillMark className="ml-auto h-3.5 w-3.5 opacity-80" />
      </div>
      <div className="px-3 py-3">
        <div className="text-sm font-semibold text-foreground">{data.label}</div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{data.sub}</p>
        <div className="mt-3 space-y-1">
          <div className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-[10px] font-mono text-muted-foreground">
            tools/list
          </div>
          <div className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-[10px] font-mono text-muted-foreground">
            tools/call
          </div>
        </div>
      </div>
      <NodePort id={WIRE_IN} type="target" side="left" placement="bottom" className="border-primary/20 bg-primary/[0.04]">
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
      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Min value (SUI)</span>
          <input
            type="number"
            min="0"
            step="any"
            className={fieldCls}
            value={data.minValue ?? "0"}
            onChange={(e) => patch({ minValue: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Coin type</span>
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


export type WalletNodeData = {
  label?: string;
  packageId?: string;
  walletId?: string;
  capId?: string;
  balanceManagerId?: string;
  tradeCapId?: string;
  coinType?: string;
};

function WalletNodeImpl({ data, selected }: NodeProps<WalletNodeData>) {
  const balance = "$0.000735";
  const suiBalance = "0.001 SUI";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`relative min-w-[260px] overflow-visible rounded-2xl border border-border/70 bg-card shadow-[var(--shadow-soft)] ${
        selected ? "ring-2 ring-primary/60" : ""
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2 rounded-t-2xl bg-mint text-mint-foreground">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-mint-foreground/15">
          <Wallet className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
        <div>
          <div className="text-[11px] uppercase tracking-widest opacity-80">Agent wallet</div>
          <div className="text-sm font-semibold">{data.label || "Wallet"}</div>
        </div>
      </div>

      <div className="px-3 py-3">
        <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-mint/80 via-emerald-500/60 to-teal-600/80 p-3 text-background">
          <div className="absolute right-2 top-2 flex items-center gap-1 text-[10px] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-background" />
            ACTIVE
          </div>
          <div className="text-[10px] uppercase tracking-widest opacity-90">Balance</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight">{balance}</div>
          <div className="mt-2 flex items-center justify-between text-[11px] opacity-90">
            <span>{suiBalance}</span>
            <span>{balance}</span>
          </div>
        </div>
      </div>

      <Handle id={WIRE_IN} type="target" position={Position.Left} className="flow-handle" />
      <Handle id={WIRE_OUT} type="source" position={Position.Right} className="flow-handle" />
    </motion.div>
  );
}

export const WalletNode = memo(WalletNodeImpl);
