import { memo, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "reactflow";
import { X } from "lucide-react";

function DeletableEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  markerEnd,
  style,
  className,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const showDelete = selected || hovered;

  return (
    <g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={28} />
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label="Remove connection"
          onClick={(e) => {
            e.stopPropagation();
            setEdges((eds) => eds.filter((edge) => edge.id !== id));
          }}
          className={`nodrag nopan absolute flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-[var(--shadow-soft)] transition hover:bg-destructive hover:text-destructive-foreground hover:border-destructive/40 ${
            showDelete ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none"
          }`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: showDelete ? "all" : "none",
          }}
        >
          <X className="h-3 w-3" />
        </button>
      </EdgeLabelRenderer>
    </g>
  );
}

export const DeletableEdge = memo(DeletableEdgeImpl);
