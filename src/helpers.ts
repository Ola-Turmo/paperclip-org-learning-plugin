/**
 * In-memory store and query helpers for ALL uos.org-learning entities.
 * SurrealDB Cloud is used as the primary persistence layer when env vars
 * are set (SURREALDB_URL, SURREALDB_PASS).  Falls back to in-memory when
 * the database is unavailable so the plugin works in dev/CI without a DB.
 *
 * Stores:
 *   - learnings[]     — LearningTag+Learning artifacts with full-text search
 *   - playbooks[]     — Predefined task templates
 *   - policies[]      — Formal organizational rules
 *   - deliverables[]  — Agent run output artifacts
 *   - scorecards[]    — KPI metrics per scope
 *   - retrospectives[]— Post-mortem summaries
 *   - auditLog[]      — Immutable action audit trail
 *
 * Supersession:  When a learning is updated, the prior version is marked
 *   supersededBy → new.id, and the new version records supersedes → [old.id].
 *   This creates a linked chain so agents can trace the evolution of knowledge.
 *
 * Scorecard:  deliverable.approve / .reject calls append a scorecard history
 *   entry so teams can track quality trends over time.
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
  LearningTag,
  Playbook,
  Policy,
  Deliverable,
  DeliverableStatus,
  Scorecard,
  ScorecardHistoryEntry,
  Retrospective,
  RetrospectiveStatus,
  AuditEntry,
  ActorType,
} from "./types.js";

import { indexLearning, removeFromIndex, bm25Search, indexPlaybook, rebuildIndex } from "./search.js";

// ---------------------------------------------------------------------------
// Persistence layer (lazy import to avoid circular deps)
// ---------------------------------------------------------------------------

let _db: typeof import("./db.js") | null = null;

async function getDb() {
  if (!_db) _db = await import("./db.js");
  return _db;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

let _learnings: Learning[] = [];
let _playbooks: Playbook[] = [];
let _policies: Policy[] = [];
let _deliverables: Deliverable[] = [];
let _scorecards: Scorecard[] = [];
let _retrospectives: Retrospective[] = [];
let _auditLog: AuditEntry[] = [];

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------

export function getLearningsStore(): Learning[] { return _learnings; }
export function getPlaybooksStore(): Playbook[] { return _playbooks; }
export function getPoliciesStore(): Policy[] { return _policies; }
export function getDeliverablesStore(): Deliverable[] { return _deliverables; }
export function getScorecardsStore(): Scorecard[] { return _scorecards; }
export function getRetrospectivesStore(): Retrospective[] { return _retrospectives; }
export function getAuditLogStore(): AuditEntry[] { return _auditLog; }

export function clearStore(): void {
  _learnings = [];
  _playbooks = [];
  _policies = [];
  _deliverables = [];
  _scorecards = [];
  _retrospectives = [];
  _auditLog = [];
}

/** Rehydrate from persisted store (called after DB connect). */
export async function rehydrateFromDb(): Promise<void> {
  const db = await getDb();
  if (await db.connectDatabase()) {
    _learnings = await db.dbSelectAllLearnings();
    _playbooks = await db.dbSelectAllPlaybooks();
    _deliverables = [];
    _retrospectives = [];
    _scorecards = [];
    _auditLog = [];
    await rebuildIndex(_learnings, _playbooks);
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// Audit log (append-only)
// ---------------------------------------------------------------------------

export function appendAudit(
  action: string,
  actorId: string,
  actorType: ActorType,
  note?: string
): void {
  const entry: AuditEntry = {
    action, actorId, actorType, note,
    timestamp: new Date().toISOString(),
  };
  _auditLog.push(entry);
  getDb().then(db => db.dbAppendAudit(entry)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Learning CRUD + queries (with SurrealDB persistence + BM25 ranking)
// ---------------------------------------------------------------------------

export async function createLearning(params: LearningCreateParams): Promise<Learning> {
  const now = new Date().toISOString();
  const learning: Learning = {
    id:         genId("lrn"),
    title:      params.title,
    body:       params.body,
    source:     params.source,
    sourceId:   params.sourceId,
    sourceName: params.sourceName,
    tags:       params.tags ?? [],
    status:     "active",
    priority:   params.priority ?? "medium",
    createdAt:  now,
    updatedAt:  now,
    createdBy:  params.createdBy,
  };

  _learnings.push(learning);
  appendAudit("learning.created", learning.id, "agent", `Created: ${learning.title}`);

  // Persist + index
  const db = await getDb();
  if (db.isConnected()) {
    await db.dbUpsertLearning(learning).catch(console.error);
  }
  await indexLearning(learning).catch(console.error);

  return learning;
}

/** Create a new version of an existing learning, marking the old one as superseded. */
export async function supersedeLearning(
  originalId: string,
  newParams: LearningCreateParams
): Promise<{ new: Learning; superseded: Learning } | null> {
  const original = _learnings.find(l => l.id === originalId);
  if (!original) return null;

  const now = new Date().toISOString();
  const updatedOriginal: Learning = {
    ...original,
    status:     "superseded",
    supersededBy: undefined,   // will be set below
    updatedAt:   now,
  };
  const updatedSupersedes = [...(original.supersedes ?? []), originalId];

  const newLearning: Learning = {
    id:          genId("lrn"),
    title:       newParams.title,
    body:        newParams.body,
    source:      newParams.source,
    sourceId:    newParams.sourceId,
    sourceName:  newParams.sourceName,
    tags:        newParams.tags ?? [],
    status:      "active",
    priority:     newParams.priority ?? original.priority,
    createdAt:   now,
    updatedAt:   now,
    createdBy:   newParams.createdBy,
    supersededBy: originalId,
    supersedes:  updatedSupersedes,
  };

  // Mark original as superseded by new
  updatedOriginal.supersededBy = newLearning.id;

  const db = await getDb();

  // Update in-memory
  const origIdx = _learnings.findIndex(l => l.id === originalId);
  if (origIdx !== -1) _learnings[origIdx] = updatedOriginal;
  _learnings.push(newLearning);

  // Persist both
  if (db.isConnected()) {
    await db.dbUpsertLearning(updatedOriginal).catch(console.error);
    await db.dbUpsertLearning(newLearning).catch(console.error);
  }
  await removeFromIndex(originalId).catch(console.error);
  await indexLearning(newLearning).catch(console.error);

  appendAudit("learning.superseded", newLearning.id, "agent",
    `Superseded ${originalId}: ${original.title}`);
  return { new: newLearning, superseded: updatedOriginal };
}

export async function updateLearning(params: LearningUpdateParams): Promise<Learning | null> {
  const idx = _learnings.findIndex(l => l.id === params.id);
  if (idx === -1) return null;
  const existing = _learnings[idx];
  const updated: Learning = {
    ...existing,
    title:    params.title ?? existing.title,
    body:     params.body ?? existing.body,
    tags:     params.tags ?? existing.tags,
    status:   params.status ?? existing.status,
    priority: params.priority ?? existing.priority,
    updatedAt: new Date().toISOString(),
  };
  _learnings[idx] = updated;
  appendAudit("learning.updated", updated.id, "agent", `Updated: ${updated.title}`);

  const db = await getDb();
  if (db.isConnected()) {
    await db.dbUpdateLearning(updated.id, updated).catch(console.error);
  }
  await indexLearning(updated).catch(console.error);
  return updated;
}

export async function archiveLearning(id: string): Promise<Learning | null> {
  return await updateLearning({ id, status: "archived" });
}

export function getLearningById(id: string): Learning | null {
  return _learnings.find(l => l.id === id) ?? null;
}

/**
 * Query learnings with optional BM25 ranking.
 * When a free-text query is provided, BM25 scores are merged with structured
 * filters (source, tags, priority, status) to return relevance-ranked results.
 */
export async function queryLearningsWithRanking(q: LearningQuery): Promise<Learning[]> {
  let results: Learning[];

  if (q.query) {
    // BM25 ranking — get ids sorted by relevance
    const scoredIds = await bm25Search(q.query, q.limit ?? 50);
    const scoredMap = new Map(scoredIds.map((s, i) => [s.id, scoredIds.length - i])); // higher = better
    const allMatched = [..._learnings].filter(l =>
      l.title.toLowerCase().includes(q.query!.toLowerCase()) ||
      l.body.toLowerCase().includes(q.query!.toLowerCase()) ||
      l.tags.some(t => t.name.toLowerCase().includes(q.query!.toLowerCase()))
    );
    // Sort by BM25 score
    allMatched.sort((a, b) => (scoredMap.get(b.id) ?? 0) - (scoredMap.get(a.id) ?? 0));
    results = allMatched;
  } else {
    results = [..._learnings];
  }

  if (q.sourceId) {
    results = results.filter(l => l.sourceId === q.sourceId);
  }
  if (q.sources?.length) {
    results = results.filter(l => q.sources!.includes(l.source));
  }
  if (q.tags?.length) {
    results = results.filter(l =>
      q.tags!.every(qt => l.tags.some(lt => lt.name === qt))
    );
  }
  if (q.priority) {
    results = results.filter(l => l.priority === q.priority);
  }
  if (q.status) {
    results = results.filter(l => l.status === q.status);
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return q.limit ? results.slice(0, q.limit) : results;
}

/** Legacy synchronous query (used in worker.ts jobs where async isn't possible) */
export function queryLearnings(q: LearningQuery): Learning[] {
  let results = [..._learnings];

  if (q.query) {
    const lower = q.query.toLowerCase();
    results = results.filter(l =>
      l.title.toLowerCase().includes(lower) ||
      l.body.toLowerCase().includes(lower) ||
      l.tags.some(t => t.name.toLowerCase().includes(lower))
    );
  }
  if (q.sourceId) {
    results = results.filter(l => l.sourceId === q.sourceId);
  }
  if (q.sources?.length) {
    results = results.filter(l => q.sources!.includes(l.source));
  }
  if (q.tags?.length) {
    results = results.filter(l =>
      q.tags!.every(qt => l.tags.some(lt => lt.name === qt))
    );
  }
  if (q.priority) {
    results = results.filter(l => l.priority === q.priority);
  }
  if (q.status) {
    results = results.filter(l => l.status === q.status);
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return q.limit ? results.slice(0, q.limit) : results;
}

export function getLearningsBySource(source: LearningSource, limit?: number): Learning[] {
  return queryLearnings({ sources: [source], status: "active", limit });
}

// ---------------------------------------------------------------------------
// Summary / health
// ---------------------------------------------------------------------------

function countByField<T extends Learning>(store: T[], field: (l: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of store) {
    const key = field(l);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function computeSummary(): LearningSummary {
  const active = _learnings.filter(l => l.status === "active");
  const bySource  = countByField(active, l => l.source)  as Record<LearningSource, number>;
  const byPriority = countByField(active, l => l.priority) as Record<LearningPriority, number>;
  const byStatus  = countByField(_learnings, l => l.status) as Record<LearningStatus, number>;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentCount = active.filter(l => new Date(l.createdAt) >= sevenDaysAgo).length;

  return { totalLearnings: _learnings.length, bySource, byPriority, byStatus, recentCount };
}

export function computeHealth(): { status: "ok" | "degraded"; checkedAt: string; message?: string } {
  const summary = computeSummary();
  if (summary.totalLearnings === 0) {
    return { status: "degraded", checkedAt: new Date().toISOString(), message: "No learnings recorded yet." };
  }
  if (summary.recentCount === 0) {
    return { status: "degraded", checkedAt: new Date().toISOString(), message: "No new learnings in the last 7 days." };
  }
  return { status: "ok", checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

export async function createPlaybook(params: {
  title: string; body: string; tags?: LearningTag[];
  source?: LearningSource; sourceId?: string; sourceName?: string; createdBy?: string;
}): Promise<Playbook> {
  const now = new Date().toISOString();
  const playbook: Playbook = {
    id:        genId("play"),
    title:     params.title,
    body:      params.body,
    tags:      params.tags ?? [],
    sourceInfo: params.source
      ? { source: params.source, sourceId: params.sourceId, sourceName: params.sourceName }
      : undefined,
    createdAt: now,
    updatedAt: now,
    createdBy: params.createdBy,
  };
  _playbooks.push(playbook);
  appendAudit("playbook.created", playbook.id, "agent", `Created: ${playbook.title}`);

  const db = await getDb();
  if (db.isConnected()) {
    await db.dbUpsertPlaybook(playbook).catch(console.error);
  }
  await indexPlaybook(playbook).catch(console.error);
  return playbook;
}

export function searchPlaybooks(query?: string, tags?: string[]): Playbook[] {
  let results = [..._playbooks];
  if (query) {
    const lower = query.toLowerCase();
    results = results.filter(p =>
      p.title.toLowerCase().includes(lower) ||
      p.body.toLowerCase().includes(lower)
    );
  }
  if (tags?.length) {
    results = results.filter(p => tags.every(t => p.tags.some(pt => pt.name === t)));
  }
  return results.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export async function createPolicy(params: {
  title: string; body: string; tags?: LearningTag[];
  source?: LearningSource; sourceId?: string; sourceName?: string; createdBy?: string;
}): Promise<Policy> {
  const now = new Date().toISOString();
  const policy: Policy = {
    id:        genId("pol"),
    title:     params.title,
    body:      params.body,
    tags:      params.tags ?? [],
    sourceInfo: params.source
      ? { source: params.source, sourceId: params.sourceId, sourceName: params.sourceName }
      : undefined,
    createdAt: now,
    updatedAt: now,
    createdBy: params.createdBy,
  };
  _policies.push(policy);
  appendAudit("policy.created", policy.id, "agent", `Created: ${policy.title}`);

  const db = await getDb();
  if (db.isConnected()) {
    await db.dbUpsertPolicy(policy).catch(console.error);
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Deliverables (with scorecard history wiring)
// ---------------------------------------------------------------------------

export async function createDeliverable(params: {
  relatedRunId: string; agentId: string; status?: DeliverableStatus;
}): Promise<Deliverable> {
  const now = new Date().toISOString();
  const d: Deliverable = {
    id:             genId("del"),
    relatedRunId:   params.relatedRunId,
    agentId:        params.agentId,
    status:         params.status ?? "pending_review",
    createdAt:      now,
    updatedAt:      now,
  };
  _deliverables.push(d);
  appendAudit("deliverable.created", d.id, "agent", `Run: ${d.relatedRunId}`);

  const db = await getDb();
  if (db.isConnected()) {
    await db.dbUpsertDeliverable(d).catch(console.error);
  }
  return d;
}

/** Approve a deliverable and record scorecard history (for quality tracking). */
export async function approveDeliverable(id: string, feedback?: string): Promise<Deliverable | null> {
  const d = _deliverables.find(x => x.id === id);
  if (!d) return null;
  d.status    = "approved";
  d.feedback   = feedback;
  d.updatedAt  = new Date().toISOString();

  // Wire scorecard history: record +1 for approved
  await recordScorecardHistory(d.agentId, d.relatedRunId, "deliverable_quality", 1);

  appendAudit("deliverable.approved", id, "agent", feedback);
  const db = await getDb();
  if (db.isConnected()) await db.dbUpsertDeliverable(d).catch(console.error);
  return d;
}

/** Reject a deliverable and record scorecard history (for quality tracking). */
export async function rejectDeliverable(id: string, feedback?: string): Promise<Deliverable | null> {
  const d = _deliverables.find(x => x.id === id);
  if (!d) return null;
  d.status   = "rejected";
  d.feedback  = feedback;
  d.updatedAt  = new Date().toISOString();

  // Wire scorecard history: record 0 for rejected
  await recordScorecardHistory(d.agentId, d.relatedRunId, "deliverable_quality", 0);

  appendAudit("deliverable.rejected", id, "agent", feedback);
  const db = await getDb();
  if (db.isConnected()) await db.dbUpsertDeliverable(d).catch(console.error);
  return d;
}

// ---------------------------------------------------------------------------
// Scorecard helpers
// ---------------------------------------------------------------------------

/** Record a scorecard history entry and update the in-memory store. */
async function recordScorecardHistory(
  agentId: string, runId: string, metricName: string, value: number
): Promise<ScorecardHistoryEntry | null> {
  const db = await getDb();

  // Update in-memory scorecard store
  const existing = _scorecards.find(s =>
    s.scopeKind === "agent" && s.scopeId === agentId && s.metricName === metricName
  );
  const entry: ScorecardHistoryEntry = { value, timestamp: new Date().toISOString() };

  if (existing) {
    existing.currentValue = value;
    existing.history.push(entry);
  } else {
    _scorecards.push({
      scopeKind:  "agent",
      scopeId:    agentId,
      metricName,
      currentValue: value,
      targetValue: 1,
      history:    [entry],
    });
  }

  // Persist to SurrealDB if connected
  if (db.isConnected()) {
    try {
      return await db.dbAppendScorecardHistory("agent", agentId, metricName, value);
    } catch (err) {
      console.error("[scorecard] Failed to persist", err);
    }
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Retrospectives
// ---------------------------------------------------------------------------

export async function createOrUpdateRetrospective(params: {
  scopeKind: string; scopeId: string;
  keyFindings?: string[]; actionItems?: string[]; status?: RetrospectiveStatus;
}): Promise<Retrospective> {
  const existing = _retrospectives.find(
    r => r.scopeKind === params.scopeKind && r.scopeId === params.scopeId
  );
  const now = new Date().toISOString();

  if (existing) {
    if (params.keyFindings)  existing.keyFindings  = params.keyFindings;
    if (params.actionItems)  existing.actionItems  = params.actionItems;
    if (params.status)      existing.status        = params.status;
    existing.updatedAt = now;
    appendAudit("retrospective.updated", existing.scopeId, "agent");
    const db = await getDb();
    if (db.isConnected()) await db.dbUpsertRetrospective(existing).catch(console.error);
    return existing;
  }

  const retro: Retrospective = {
    scopeKind:    params.scopeKind,
    scopeId:      params.scopeId,
    linkedDeliverableIds: [],
    keyFindings:  params.keyFindings ?? [],
    actionItems:  params.actionItems ?? [],
    status:       params.status ?? "draft",
    createdAt:    now,
    updatedAt:    now,
  };
  _retrospectives.push(retro);
  appendAudit("retrospective.created", params.scopeId, "agent");
  const db = await getDb();
  if (db.isConnected()) await db.dbUpsertRetrospective(retro).catch(console.error);
  return retro;
}

export function getRetrospective(scopeKind: string, scopeId: string): Retrospective | null {
  return _retrospectives.find(r => r.scopeKind === scopeKind && r.scopeId === scopeId) ?? null;
}

// ---------------------------------------------------------------------------
// Seed demo data
// ---------------------------------------------------------------------------

export async function seedDemoLearnings(): Promise<void> {
  if (_learnings.length > 0) return;

  const seeds: LearningCreateParams[] = [
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
      title: "Use readiness packets for launch decisions instead of ad-hoc checklists",
      body: "LaunchReadinessService provides structured readiness scoring. Always create a ReadinessPacket before any go/no-go decision.",
      source: "project",
      sourceName: "UOS v2 Migration",
      tags: [{ name: "launch", source: "project" }, { name: "readiness", source: "workflow" }],
      priority: "high",
      createdBy: "dept-product-tech",
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
  ];

  for (const params of seeds) {
    await createLearning(params);
  }

  await createPlaybook({
    title: "Incident Response Playbook",
    body: "## Incident Response\n\n1. **Detect** — Alert fires in monitoring dashboard\n2. **Triage** — Classify severity (P1/P2/P3/P4)\n3. **Assemble** — Page on-call, open incident issue\n4. **Mitigate** — Apply rollback or hotfix\n5. **Resolve** — Confirm service restored\n6. **Retro** — Schedule retrospective within 48h\n\nSee the Retrospective tab on the incident issue for auto-generated findings.",
    tags: [{ name: "incident", source: "playbook" }, { name: "operations", source: "playbook" }],
    source: "manual",
    createdBy: "org-learning-plugin",
  });

  await createPlaybook({
    title: "Code Review Playbook",
    body: "## Code Review Checklist\n\n1. **Correctness** — Does it solve the stated problem?\n2. **Testing** — Are there unit/integration tests?\n3. **Performance** — Any N+1 queries or expensive operations?\n4. **Security** — Input validation, auth checks, secrets management\n5. **Readability** — Clear naming, documented intent\n6. **Documentation** — README/API docs updated if needed",
    tags: [{ name: "code-review", source: "playbook" }, { name: "quality", source: "playbook" }],
    source: "manual",
    createdBy: "org-learning-plugin",
  });

  await createPlaybook({
    title: "Architecture Decision Playbook",
    body: "## ADR Process\n\n1. **Context** — What forces are driving this change?\n2. **Decision** — What is the proposed solution?\n3. **Consequences** — Document both positive and negative outcomes\n4. **Alternatives considered** — Why were other options rejected?\n\nUse the Architecture Decision template in the project root. Link the ADR in the pull request description.",
    tags: [{ name: "architecture", source: "playbook" }, { name: "adr", source: "playbook" }],
    source: "manual",
    createdBy: "org-learning-plugin",
  });
}
