import { type ReactNode } from "react";
import { Handle, Position, type HandleType } from "reactflow";
import { WIRE_IN, WIRE_OUT } from "@/lib/wire-inference";
import { cn } from "@/lib/utils";

type WireHandleProps = {
  id: string;
  type: HandleType;
  side: "left" | "right";
};

function WireHandle({ id, type, side }: WireHandleProps) {
  return (
    <Handle
      id={id}
      type={type}
      position={side === "left" ? Position.Left : Position.Right}
      className="flow-handle-port flow-handle-inline shrink-0"
    />
  );
}

// Just the port identity — the "← upstream" / "downstream" hint text was noise the card didn't
// need (the top-of-canvas "Wire out → in" pill already explains direction), so it's dropped.
export function FlowInLabels() {
  return <span className="font-mono text-muted-foreground">flow in</span>;
}

export function FlowOutLabels() {
  return <span className="ml-auto font-mono text-muted-foreground">flow out</span>;
}

export function NodePort({
  id,
  type,
  side,
  placement,
  className,
  children,
}: {
  id?: string;
  type: HandleType;
  side: "left" | "right";
  /** Where the strip sits on the node — defaults to top for in, bottom for out */
  placement?: "top" | "bottom";
  className?: string;
  children: ReactNode;
}) {
  const handleId = id ?? (side === "left" ? WIRE_IN : WIRE_OUT);
  const strip = placement ?? (side === "left" ? "top" : "bottom");
  return (
    <div
      className={cn(
        "flex min-h-[38px] items-center gap-2 border-dashed border-border/55 bg-muted/25 px-2 py-2.5 text-[10px]",
        strip === "top" ? "border-b" : "border-t",
        className,
      )}
    >
      {side === "left" && <WireHandle id={handleId} type={type} side="left" />}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {side === "right" && <WireHandle id={handleId} type={type} side="right" />}
    </div>
  );
}
