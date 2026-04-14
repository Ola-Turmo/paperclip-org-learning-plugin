/**
 * In-memory store and query helpers for learnings.
 */

import type {
  Learning,
  LearningSummary,
  LearningQuery,
  LearningCreateParams,
  LearningUpdateParams,
  LearningSource,
  LearningPriority,
  LearningStatus,
} from "./types.js";

let _store: Learning[] = [];

// ---------------------------------------------------------------------------
// Store management
// ---------------------------------------------------------------------------

export function getStore(): Learning[] {
  return _store;
}

export function clearStore(): void {
  _store = [];
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(): string {
  return `lrn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createLearning(params: LearningCreateParams): Learning {
  const now = new Date().toISOString();
  const learning: Learning = {
    id: generateId(),
    title: params.title,
    body: params.body,
    source: params.source,
    sourceId: params.sourceId,
    sourceName: params.sourceName,
    tags: params.tags ?? [],
    status: "active",
    priority: params.priority ?? "medium",
    createdAt: now,
    updatedAt: now,
    createdBy: params.createdBy,
  };
  _store.push(learning);
  return learning;
}

export function updateLearning(params: LearningUpdateParams): Learning | null {
  const idx = _store.findIndex((l) => l.id === params.id);
  if (idx === -1) return null;

  const existing = _store[idx];
  const updated: Learning = {
    ...existing,
    title: params.title ?? existing.title,
    body: params.body ?? existing.body,
    tags: params.tags ?? existing.tags,
    status: params.status ?? existing.status,
    priority: params.priority ?? existing.priority,
    updatedAt: new Date().toISOString(),
  };
  _store[idx] = updated;
  return updated;
}

export function archiveLearning(id: string): Learning | null {
  return updateLearning({ id, status: "archived" });
}

export function getLearningById(id: string): Learning | null {
  return _store.find((l) => l.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function queryLearnings(q: LearningQuery): Learning[] {
  let results = [..._store];

  if (q.query) {
    const lower = q.query.toLowerCase();
    results = results.filter(
      (l) =>
        l.title.toLowerCase().includes(lower) ||
        l.body.toLowerCase().includes(lower) ||
        l.tags.some((t) => t.name.toLowerCase().includes(lower))
    );
  }

  if (q.sources?.length) {
    results = results.filter((l) => q.sources!.includes(l.source));
  }

  if (q.tags?.length) {
    results = results.filter((l) =>
      q.tags!.every((qt) => l.tags.some((lt) => lt.name === qt))
    );
  }

  if (q.priority) {
    results = results.filter((l) => l.priority === q.priority);
  }

  if (q.status) {
    results = results.filter((l) => l.status === q.status);
  }

  // Always sort by updatedAt descending
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return q.limit ? results.slice(0, q.limit) : results;
}

export function getLearningsBySource(source: LearningSource, limit?: number): Learning[] {
  return queryLearnings({ sources: [source], status: "active", limit });
}

// ---------------------------------------------------------------------------
// Summary / health
// ---------------------------------------------------------------------------

function countByField<K extends string>(field: (l: Learning) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of _store) {
    const key = field(l);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function computeSummary(): LearningSummary {
  const active = _store.filter((l) => l.status === "active");
  const bySource = countByField((l) => l.source) as Record<LearningSource, number>;
  const byPriority = countByField((l) => l.priority) as Record<LearningPriority, number>;
  const byStatus = countByField((l) => l.status) as Record<LearningStatus, number>;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentCount = active.filter((l) => new Date(l.createdAt) >= sevenDaysAgo).length;

  return {
    totalLearnings: _store.length,
    bySource,
    byPriority,
    byStatus,
    recentCount,
  };
}

export function computeHealth(): { status: "ok" | "degraded"; checkedAt: string; message?: string } {
  const summary = computeSummary();
  if (summary.totalLearnings === 0) {
    return {
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: "No learnings recorded yet.",
    };
  }
  if (summary.recentCount === 0) {
    return {
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: "No new learnings in the last 7 days.",
    };
  }
  return {
    status: "ok",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Seed data for demo / testing
// ---------------------------------------------------------------------------

export function seedDemoLearnings(): void {
  if (_store.length > 0) return;

  const demoLearnings: LearningCreateParams[] = [
    {
      title: "Connector Slack callbacks fail after upstream API change",
      body: "When Slack changes their callback signature, replaying missed events requires manual reconciliation. Always check the x-signature-timestamp header before replay.",
      source: "incident",
      sourceId: "slack-callback-mismatch",
      sourceName: "Slack Connector",
      tags: [{ name: "slack", source: "connector" }, { name: "callbacks", source: "connector" }],
      priority: "high",
      createdBy: "ops-cockpit",
    },
    {
      title: "Department health degrades when tools are unregistered mid-flight",
      body: "Tools must be gracefully deregistered — mark them as degraded before removing from the registry to prevent orphaned actions.",
      source: "department",
      sourceId: "uos-department-product-tech",
      sourceName: "Product Tech Department",
      tags: [{ name: "health", source: "department" }, { name: "tools", source: "system" }],
      priority: "medium",
      createdBy: "dept-product-tech",
    },
    {
      title: "Use readiness packets for launch decisions instead of ad-hoc checklists",
      body: "LaunchReadinessService provides structured readiness scoring. Always create a ReadinessPacket before any go/no-go decision.",
      source: "project",
      sourceName: "UOS v2 Migration",
      tags: [{ name: "launch", source: "project" }, { name: "readiness", source: "workflow" }],
      priority: "high",
      createdBy: "dept-product-tech",
    },
  ];

  for (const params of demoLearnings) {
    createLearning(params);
  }
}
