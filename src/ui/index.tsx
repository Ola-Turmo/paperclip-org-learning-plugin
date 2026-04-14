/**
 * React UI widgets for uos.org-learning plugin.
 */

import type { CSSProperties } from "react";
import {
  usePluginData,
  usePluginAction,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

import type { Learning, LearningSummary } from "../types.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type HealthData = {
  status: "ok" | "degraded";
  checkedAt: string;
  message?: string;
};

type LearningListData = {
  learnings?: Learning[];
};

type SummaryData = LearningSummary;

// ---------------------------------------------------------------------------
// Style helpers (outside the styles record to avoid TS record typing issues)
// ---------------------------------------------------------------------------

function priorityBadgeStyle(priority: string): CSSProperties {
  if (priority === "critical")
    return { fontSize: "10px", fontWeight: 600, textTransform: "uppercase", padding: "1px 5px", borderRadius: "3px", background: "#fee2e2", color: "#991b1b" };
  if (priority === "high")
    return { fontSize: "10px", fontWeight: 600, textTransform: "uppercase", padding: "1px 5px", borderRadius: "3px", background: "#fef3c7", color: "#92400e" };
  if (priority === "medium")
    return { fontSize: "10px", fontWeight: 600, textTransform: "uppercase", padding: "1px 5px", borderRadius: "3px", background: "#dbeafe", color: "#1e40af" };
  return { fontSize: "10px", fontWeight: 600, textTransform: "uppercase", padding: "1px 5px", borderRadius: "3px", background: "#e5e7eb", color: "#374151" };
}

function healthDotStyle(status: string): CSSProperties {
  return {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: status === "ok" ? "#22c55e" : status === "degraded" ? "#f59e0b" : "#9ca3af",
    display: "inline-block",
  };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const base: CSSProperties = { fontFamily: "system-ui, sans-serif", fontSize: "14px" };

const S = {
  container: { ...base, padding: "0.75rem", display: "grid", gap: "0.5rem" } as CSSProperties,
  header: { display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, fontSize: "14px" } as CSSProperties,
  refreshButton: {
    marginLeft: "auto",
    padding: "2px 8px",
    fontSize: "12px",
    cursor: "pointer",
    border: "1px solid #ccc",
    borderRadius: "4px",
    background: "#f5f5f5",
  } as CSSProperties,
  empty: { color: "#666", fontSize: "13px", fontStyle: "italic" } as CSSProperties,
  feed: { display: "grid", gap: "0.5rem", maxHeight: "400px", overflowY: "auto" } as CSSProperties,
  card: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    padding: "0.5rem 0.625rem",
    background: "#fafafa",
    display: "grid",
    gap: "0.25rem",
  } as CSSProperties,
  cardHeader: { display: "flex", gap: "0.375rem", alignItems: "center" } as CSSProperties,
  cardTitle: { fontWeight: 600, fontSize: "13px", lineHeight: 1.3 } as CSSProperties,
  cardBody: { fontSize: "12px", color: "#444", lineHeight: 1.4 } as CSSProperties,
  sourceTag: { fontSize: "10px", background: "#f3f4f6", color: "#6b7280", padding: "1px 5px", borderRadius: "3px", border: "1px solid #e5e7eb" } as CSSProperties,
  tagRow: { display: "flex", gap: "0.25rem", flexWrap: "wrap" as const, marginTop: "0.125rem" },
  tag: { fontSize: "10px", background: "#eff6ff", color: "#1d4ed8", padding: "1px 5px", borderRadius: "3px" } as CSSProperties,
  healthMessage: { fontSize: "12px", color: "#92400e", background: "#fef3c7", padding: "0.25rem 0.5rem", borderRadius: "4px" } as CSSProperties,
  statsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginTop: "0.25rem" } as CSSProperties,
  stat: { textAlign: "center" as const, padding: "0.5rem", background: "#f5f5f5", borderRadius: "6px", border: "1px solid #e5e7eb" } as CSSProperties,
  statValue: { fontSize: "20px", fontWeight: 700, lineHeight: 1 } as CSSProperties,
  statLabel: { fontSize: "11px", color: "#6b7280", marginTop: "2px" } as CSSProperties,
};

// ---------------------------------------------------------------------------
// LearningWidget — recent learnings feed
// ---------------------------------------------------------------------------

export function LearningWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<LearningListData>("learning.list");
  const refreshAction = usePluginAction("learning.query");

  if (loading) return <div style={S.container}>Loading learnings…</div>;
  if (error) return <div style={S.container}>Error: {error.message}</div>;

  const learnings = data?.learnings ?? [];

  return (
    <div style={S.container}>
      <div style={S.header}>
        <strong>Org Learning Feed</strong>
        <button style={S.refreshButton} onClick={() => void refreshAction({ limit: 10 })}>
          Refresh
        </button>
      </div>

      {learnings.length === 0 ? (
        <div style={S.empty}>No learnings yet. Ingest one from an incident or project.</div>
      ) : (
        <div style={S.feed}>
          {learnings.slice(0, 8).map((l) => (
            <div key={l.id} style={S.card}>
              <div style={S.cardHeader}>
                <span style={priorityBadgeStyle(l.priority)}>{l.priority}</span>
                <span style={S.sourceTag}>{l.source}</span>
              </div>
              <div style={S.cardTitle}>{l.title}</div>
              <div style={S.cardBody}>
                {l.body.slice(0, 120)}
                {l.body.length > 120 ? "…" : ""}
              </div>
              {l.tags.length > 0 && (
                <div style={S.tagRow}>
                  {l.tags.slice(0, 4).map((t) => (
                    <span key={t.name} style={S.tag}>{t.name}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LearningHealthWidget — summary stats
// ---------------------------------------------------------------------------

export function LearningHealthWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("learning.health");
  const { data: summaryData } = usePluginData<SummaryData>("learning.summary");

  if (loading) return <div style={S.container}>Loading health…</div>;
  if (error) return <div style={S.container}>Error: {error.message}</div>;

  const summary = summaryData;
  const health = data;

  return (
    <div style={S.container}>
      <div style={S.header}>
        <strong>Learning Health</strong>
        <span style={healthDotStyle(health?.status ?? "degraded")} />
        <span>{health?.status ?? "unknown"}</span>
      </div>

      {health?.message && <div style={S.healthMessage}>{health.message}</div>}

      {summary ? (
        <div style={S.statsGrid}>
          <div style={S.stat}>
            <div style={S.statValue}>{summary.totalLearnings}</div>
            <div style={S.statLabel}>Total</div>
          </div>
          <div style={S.stat}>
            <div style={S.statValue}>{summary.recentCount}</div>
            <div style={S.statLabel}>Last 7d</div>
          </div>
          <div style={S.stat}>
            <div style={S.statValue}>{summary.byStatus?.active ?? 0}</div>
            <div style={S.statLabel}>Active</div>
          </div>
        </div>
      ) : (
        <div style={S.empty}>No summary available.</div>
      )}
    </div>
  );
}
