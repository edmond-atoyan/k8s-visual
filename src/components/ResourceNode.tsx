import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { GROUP_ACCENT_VAR, KIND_INFO } from "../kindInfo";
import type { ResourceSummary } from "../types";

export type ResourceFlowNode = Node<
  { resource: ResourceSummary; issues?: string[]; dimmed?: boolean },
  "resource"
>;

/**
 * One resource as a small card: kind badge (group-accented), name, and
 * status as dot + text - never color alone. Resources with diagnostics get a
 * warning marker; references to missing resources render as dashed ghosts.
 */
export function ResourceNode({ data, selected }: NodeProps<ResourceFlowNode>) {
  const r = data.resource;
  const meta = KIND_INFO[r.kind];
  const ghost = r.uid.startsWith("missing:");
  return (
    <div
      className={`knode${selected ? " selected" : ""}${ghost ? " ghost" : ""}${data.dimmed ? " dimmed" : ""}`}
      style={{ "--accent": GROUP_ACCENT_VAR[meta.group] } as React.CSSProperties}
    >
      <div className="knode-top">
        <span className="knode-badge">{meta.badge}</span>
        <span className="knode-name" title={r.name}>
          {r.name}
        </span>
        {data.issues && data.issues.length > 0 && (
          <span className="knode-warn" title={data.issues.join("\n")}>
            ⚠
          </span>
        )}
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
