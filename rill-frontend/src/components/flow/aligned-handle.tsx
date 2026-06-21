import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Handle, Position, useUpdateNodeInternals, type HandleType } from "reactflow";

type HandleProps = {
  id: string;
  nodeId: string;
  type: HandleType;
  position: Position;
  alignRef: React.RefObject<HTMLElement | null>;
};

/** Handle snapped to the vertical center of `alignRef`. Hidden until measured. */
export function AlignedHandle({ id, nodeId, type, position, alignRef }: HandleProps) {
  const [top, setTop] = useState<number | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();

  useLayoutEffect(() => {
    const row = alignRef.current;
    if (!row) return;

    const compute = () => {
      const node = row.closest(".react-flow__node");
      if (!node) return;
      const nodeRect = node.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      setTop(rowRect.top - nodeRect.top + rowRect.height / 2);
      updateNodeInternals(nodeId);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(row);
    const node = row.closest(".react-flow__node");
    if (node) ro.observe(node);
    return () => ro.disconnect();
  }, [alignRef, nodeId, updateNodeInternals]);

  if (top === null) return null;

  const side = position === Position.Left ? { left: -8 } : { right: -8 };

  return (
    <Handle id={id} type={type} position={position} className="flow-handle" style={{ top, ...side }} />
  );
}

type WireRowProps = {
  nodeId: string;
  handleId: string;
  handleType: HandleType;
  handlePosition: Position;
  className?: string;
  children: ReactNode;
};

/** Dashed wire row with handle anchored to the row center. */
export function WireRow({
  nodeId,
  handleId,
  handleType,
  handlePosition,
  className = "",
  children,
}: WireRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rowRef}
      className={`relative flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-2 ${className}`}
    >
      {children}
      <AlignedHandle
        id={handleId}
        nodeId={nodeId}
        type={handleType}
        position={handlePosition}
        alignRef={rowRef}
      />
    </div>
  );
}
