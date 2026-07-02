import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { GROUP_ACCENT_VAR, KIND_INFO } from "../kindInfo";
import type { ResourceSummary } from "../types";

export type ResourceFlowNode = Node<{ resource: ResourceSummary }, "resource">;

/**
 * One resource as a small card: kind badge (group-accented), name, and
 * status as dot + text — never color alone.
 */
export function ResourceNode({ data, selected }: NodeProps<ResourceFlowNode>) {
  const r = data.resource;
  const meta = KIND_INFO[r.kind];
  return (
    <div
      className={`knode${selected ? " selected" : ""}`}
      style={{ "--accent": GROUP_ACCENT_VAR[meta.group] } as React.CSSProperties}
    >
      <div className="knode-top">
        <span className="knode-badge">{meta.badge}</span>
        <span className="knode-name" title={r.name}>
          {r.name}
        </span>
      </div>
      <div className="knode-status">
        <span className={`dot health-${r.health}`} />
        <span>{r.status}</span>
      </div>
      <Handle className="rf-handle" type="target" position={Position.Left} />
      <Handle className="rf-handle" type="source" position={Position.Right} />
    </div>
  );
}
