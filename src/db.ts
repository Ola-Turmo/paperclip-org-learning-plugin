/**
 * SurrealDB Cloud persistence layer for uos.org-learning plugin.
 *
 * Connection (v2 SDK — surrealdb npm package):
 *   WSS endpoint  → SURREALDB_URL
 *   Auth user     → SURREALDB_USER  (default: root)
 *   Auth pass     → SURREALDB_PASS
 *   Namespace     → SURREALDB_NS
 *   Database      → SURREALDB_DB
 *
 * Gracefully falls back to in-memory when env vars are absent so the plugin
 * still works in dev / CI without a live database.
 *
 * SurrealQL notes:
 *   - UPSERT requires full record IDs: learning:${id} not just ${id}
 *   - SCHEMAFULL tables enforce types; SCHEMALESS allow flexible fields
 *   - Use $var bindings for safe parameterisation
 */

import { Surreal } from "surrealdb";
import type {
  Learning,
  Playbook,
  Policy,
  Deliverable,
  Scorecard,
  ScorecardHistoryEntry,
  Retrospective,
  AuditEntry,
  LearningSource,
  LearningTag,
  LearningStatus,
  LearningPriority,
  DeliverableStatus,
  RetrospectiveStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DbConfig {
  url:       string;
  user:      string;
  pass:      string;
  namespace: string;
  database:  string;
}

function getConfig(): DbConfig | null {
  const url  = process.env.SURREALDB_URL      ?? process.env.SURREAL_DB_URL      ?? "";
  const user = process.env.SURREALDB_USER     ?? process.env.SURREAL_DB_USER     ?? "root";
  const pass = process.env.SURREALDB_PASS     ?? process.env.SURREAL_DB_PASS     ?? "";
  const ns   = process.env.SURREALDB_NS       ?? process.env.SURREAL_DB_NS       ?? "";
  const db   = process.env.SURREALDB_DB       ?? process.env.SURREAL_DB_DB       ?? "";

  if (!url || !pass) return null;
  return {
    url,
    user,
    pass,
    namespace: ns  || "demo",
    database:   db  || "surreal_deal_store",
  };
}

// ---------------------------------------------------------------------------
// Singleton client (Promise-guarded to prevent concurrent connect races)
// ---------------------------------------------------------------------------

let _db: Surreal | null = null;
let _connected = false;
let _connectPromise: Promise<boolean> | null = null;

export async function connectDatabase(): Promise<boolean> {
  if (_connected) return true;
  if (_connectPromise) return _connectPromise;

  const config = getConfig();
  if (!config) {
    console.warn("[db] No SURREALDB_URL/PASS — running in-memory mode");
    return false;
  }

  _connectPromise = _doConnect(config);
  return _connectPromise;
}

async function _doConnect(config: DbConfig): Promise<boolean> {
  try {
    _db = new Surreal();
    await _db.connect(config.url);
    await _db.use({ namespace: config.namespace, database: config.database });
    await _db.signin({ username: config.user, password: config.pass });

    // Initialize schema — define tables + indexes once
    await _ensureSchema();

    _connected = true;
    console.info(`[db] Connected to SurrealDB Cloud: ${config.namespace}/${config.database}`);
    return true;
  } catch (err) {
    console.error("[db] Connection failed — falling back to in-memory", err);
    _db = null;
    return false;
  }
}

/**
 * Initialize SurrealDB schema:
 *   - SCHEMAFULL tables for type enforcement
 *   - Indexes on commonly-queried fields for query performance
 *   - Full-text search indexes on title/body for BM25
 *
 * Safe to call multiple times — uses IF NOT EXISTS / OR IGNORE.
 */
async function _ensureSchema(): Promise<void> {
  if (!_db) return;

  // Tables — SCHEMAFULL enforces field types at write time
  for (const table of ["learning", "playbook", "policy", "deliverable", "scorecard", "retrospective", "audit_entry"]) {
    await _db.query(`DEFINE TABLE ${table} SCHEMAFULL PERMISSIONS FULL;`);
  }

  // Learning indexes
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_learning_status   ON learning COLUMNS status;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_learning_source    ON learning COLUMNS source;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_learning_priority  ON learning COLUMNS priority;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_learning_updated   ON learning COLUMNS updatedAt;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_learning_created   ON learning COLUMNS createdAt;`);

  // Playbook indexes
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_playbook_updated   ON playbook COLUMNS updatedAt;`);

  // Retrospective indexes
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_retro_scope       ON retrospective COLUMNS scopeKind, scopeId;`);

  // Deliverable indexes
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_deliverable_run   ON deliverable COLUMNS relatedRunId;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_deliverable_agent ON deliverable COLUMNS agentId;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_deliverable_status ON deliverable COLUMNS status;`);

  // Scorecard indexes
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_scorecard_scope   ON scorecard COLUMNS scopeKind, scopeId, metricName;`);

  // Full-text search indexes on title + body for BM25 ranking
  await _db.query(`DEFINE ANALYZER IF NOT EXISTS learning_analyzer FILTERS lowercase, ascii, porter;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_learning_title_fts ON learning COLUMNS title SEARCH ANALYZER learning_analyzer BM25;`);
  await _db.query(`DEFINE INDEX IF NOT EXISTS idx_learning_body_fts  ON learning COLUMNS body  SEARCH ANALYZER learning_analyzer BM25;`);

  console.info("[db] Schema initialized");
}

export function isConnected(): boolean {
  return _connected;
}

export async function dbClose(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
    _connected = false;
    _connectPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Query helper — returns first result array from a raw SurrealQL query
// ---------------------------------------------------------------------------

async function _query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
  if (!_db) return [];
  const [result] = await _db.query<[T[]]>(sql, vars);
  return result ?? [];
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

interface DbLearning {
  id:          string;
  title:       string;
  body:        string;
  source:      LearningSource;
  sourceId?:   string;
  sourceName?: string;
  tags:        LearningTag[];
  status:      LearningStatus;
  priority:    LearningPriority;
  createdAt:   string;
  updatedAt:   string;
  createdBy?:  string;
  supersededBy?: string;
  supersedes?:   string[];
}

/** Convert raw DB row to typed Learning — handles record ID formatting. */
function rowToLearning(r: Record<string, unknown>): Learning {
  return {
    id:          String(r.id ?? "").replace(/^learning:/, ""),
    title:       String(r.title ?? ""),
    body:        String(r.body ?? ""),
    source:      String(r.source ?? "manual") as LearningSource,
    sourceId:    r.sourceId   ? String(r.sourceId)   : undefined,
    sourceName:  r.sourceName ? String(r.sourceName) : undefined,
    tags:        Array.isArray(r.tags) ? r.tags as LearningTag[] : [],
    status:      String(r.status ?? "active") as LearningStatus,
    priority:    String(r.priority ?? "medium") as LearningPriority,
    createdAt:   String(r.createdAt ?? new Date().toISOString()),
    updatedAt:   String(r.updatedAt ?? new Date().toISOString()),
    createdBy:   r.createdBy ? String(r.createdBy) : undefined,
    supersededBy: r.supersededBy ? String(r.supersededBy) : undefined,
    supersedes:  Array.isArray(r.supersedes) ? r.supersedes.map(String) : undefined,
  };
}

/**
 * Upsert a learning using SurrealDB UPSERT.
 * Uses full record ID format: learning:${id}
 * Returns the saved Learning with the short id (without table prefix).
 */
export async function dbUpsertLearning(learning: Learning): Promise<Learning> {
  if (!_db) throw new Error("Database not connected");
  const recordId = `learning:${learning.id}`;
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    /* SurrealQL UPSERT — creates or replaces by record ID */
    `UPSERT ${recordId} SET
      title       = $title,
      body        = $body,
      source      = $source,
      sourceId    = $sourceId,
      sourceName  = $sourceName,
      tags        = $tags,
      status      = $status,
      priority    = $priority,
      createdAt   = $createdAt,
      updatedAt   = $updatedAt,
      createdBy   = $createdBy,
      supersededBy = $supersededBy,
      supersedes  = $supersedes
    RETURN *`,
    {
      title:       learning.title,
      body:        learning.body,
      source:      learning.source,
      sourceId:    learning.sourceId ?? null,
      sourceName:  learning.sourceName ?? null,
      tags:        learning.tags,
      status:      learning.status,
      priority:    learning.priority,
      createdAt:   learning.createdAt,
      updatedAt:   learning.updatedAt,
      createdBy:   learning.createdBy ?? null,
      supersededBy: learning.supersededBy ?? null,
      supersedes:  learning.supersedes ?? null,
    }
  );
  if (!result?.length) throw new Error("UPSERT learning failed");
  return rowToLearning(result[0]);
}

export async function dbUpdateLearning(
  id: string,
  patch: Partial<Pick<Learning, "title" | "body" | "tags" | "status" | "priority" | "supersededBy" | "supersedes">>
): Promise<Learning | null> {
  if (!_db) return null;
  const recordId = `learning:${id}`;
  const sets: string[] = [];
  const vars: Record<string, unknown> = { id };
  if (patch.title       !== undefined) { sets.push("title        = $title");        vars.title        = patch.title; }
  if (patch.body        !== undefined) { sets.push("body         = $body");         vars.body         = patch.body; }
  if (patch.tags        !== undefined) { sets.push("tags         = $tags");         vars.tags         = patch.tags; }
  if (patch.status      !== undefined) { sets.push("status       = $status");      vars.status       = patch.status; }
  if (patch.priority    !== undefined) { sets.push("priority     = $priority");    vars.priority     = patch.priority; }
  if (patch.supersededBy !== undefined) { sets.push("supersededBy = $supersededBy"); vars.supersededBy = patch.supersededBy; }
  if (patch.supersedes  !== undefined) { sets.push("supersedes   = $supersedes");  vars.supersedes  = patch.supersedes; }
  if (!sets.length) return null;
  vars.updatedAt = new Date().toISOString();
  sets.push("updatedAt = $updatedAt");
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `UPDATE ${recordId} SET ${sets.join(", ")} RETURN *`, vars
  );
  return result?.length ? rowToLearning(result[0]) : null;
}

export async function dbDeleteLearning(id: string): Promise<void> {
  if (!_db) return;
  await _db.query(`DELETE FROM learning:${id}`);
}

export async function dbSelectLearnings(opts?: {
  status?: LearningStatus; source?: LearningSource; limit?: number;
}): Promise<Learning[]> {
  if (!_db) return [];

  // Build WHERE clause in SurrealQL so filtering happens in the DB, not in-memory
  const conds: string[] = [];
  const vars: Record<string, unknown> = {};
  if (opts?.status) { conds.push("status = $status"); vars.status = opts.status; }
  if (opts?.source) { conds.push("source = $source"); vars.source = opts.source; }
  if (opts?.limit)  { vars.limit = opts.limit; }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = opts?.limit ? `LIMIT $limit` : "";
  const rows = await _query<Record<string, unknown>>(
    `SELECT * FROM learning ${where} ORDER BY updatedAt DESC ${limit}`, vars
  );
  return rows.map(rowToLearning);
}

export async function dbSelectLearningById(id: string): Promise<Learning | null> {
  if (!_db) return null;
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `SELECT * FROM learning:${id}`, {}
  );
  return result?.length ? rowToLearning(result[0]) : null;
}

export async function dbSelectAllLearnings(): Promise<Learning[]> {
  const rows = await _query<Record<string, unknown>>(
    "SELECT * FROM learning ORDER BY updatedAt DESC LIMIT 1000", {}
  );
  return rows.map(rowToLearning);
}

// ---------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------

interface DbPlaybook {
  id: string; title: string; body: string; tags: LearningTag[];
  sourceInfo?: { source: LearningSource; sourceId?: string; sourceName?: string };
  createdAt: string; updatedAt: string; createdBy?: string;
}

function rowToPlaybook(r: Record<string, unknown>): Playbook {
  return {
    id:    String(r.id ?? "").replace(/^playbook:/, ""),
    title: String(r.title ?? ""),
    body:  String(r.body ?? ""),
    tags:  Array.isArray(r.tags) ? r.tags as LearningTag[] : [],
    sourceInfo: r.sourceInfo as DbPlaybook["sourceInfo"],
    createdAt:  String(r.createdAt ?? ""),
    updatedAt:  String(r.updatedAt ?? ""),
    createdBy:  r.createdBy ? String(r.createdBy) : undefined,
  };
}

export async function dbUpsertPlaybook(p: Playbook): Promise<Playbook> {
  if (!_db) throw new Error("Database not connected");
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `UPSERT playbook:${p.id} SET
      title      = $title,
      body       = $body,
      tags       = $tags,
      sourceInfo = $sourceInfo,
      createdAt  = $createdAt,
      updatedAt  = $updatedAt,
      createdBy  = $createdBy
    RETURN *`,
    {
      title: p.title, body: p.body, tags: p.tags,
      sourceInfo: p.sourceInfo ?? null,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      createdBy: p.createdBy ?? null,
    }
  );
  if (!result?.length) throw new Error("UPSERT playbook failed");
  return rowToPlaybook(result[0]);
}

export async function dbSelectAllPlaybooks(): Promise<Playbook[]> {
  const rows = await _query<Record<string, unknown>>(
    "SELECT * FROM playbook ORDER BY updatedAt DESC LIMIT 100", {}
  );
  return rows.map(rowToPlaybook);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

interface DbPolicy {
  id: string; title: string; body: string; tags: LearningTag[];
  sourceInfo?: { source: LearningSource; sourceId?: string; sourceName?: string };
  createdAt: string; updatedAt: string; createdBy?: string;
}

function rowToPolicy(r: Record<string, unknown>): Policy {
  return {
    id:    String(r.id ?? "").replace(/^policy:/, ""),
    title: String(r.title ?? ""),
    body:  String(r.body ?? ""),
    tags:  Array.isArray(r.tags) ? r.tags as LearningTag[] : [],
    sourceInfo: r.sourceInfo as DbPolicy["sourceInfo"],
    createdAt:  String(r.createdAt ?? ""),
    updatedAt:  String(r.updatedAt ?? ""),
    createdBy:  r.createdBy ? String(r.createdBy) : undefined,
  };
}

export async function dbUpsertPolicy(p: Policy): Promise<Policy> {
  if (!_db) throw new Error("Database not connected");
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `UPSERT policy:${p.id} SET
      title      = $title,
      body       = $body,
      tags       = $tags,
      sourceInfo = $sourceInfo,
      createdAt  = $createdAt,
      updatedAt  = $updatedAt,
      createdBy  = $createdBy
    RETURN *`,
    {
      title: p.title, body: p.body, tags: p.tags,
      sourceInfo: p.sourceInfo ?? null,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      createdBy: p.createdBy ?? null,
    }
  );
  if (!result?.length) throw new Error("UPSERT policy failed");
  return rowToPolicy(result[0]);
}

// ---------------------------------------------------------------------------
// Deliverable
// ---------------------------------------------------------------------------

interface DbDeliverable {
  id: string; relatedRunId: string; agentId: string; status: DeliverableStatus;
  feedback?: string; score?: number; createdAt: string; updatedAt: string;
}

function rowToDeliverable(r: Record<string, unknown>): Deliverable {
  return {
    id:           String(r.id ?? "").replace(/^deliverable:/, ""),
    relatedRunId: String(r.relatedRunId ?? ""),
    agentId:      String(r.agentId ?? ""),
    status:       String(r.status ?? "pending_review") as DeliverableStatus,
    feedback:     r.feedback ? String(r.feedback) : undefined,
    score:        r.score !== undefined ? Number(r.score) : undefined,
    createdAt:    String(r.createdAt ?? ""),
    updatedAt:    String(r.updatedAt ?? ""),
  };
}

export async function dbUpsertDeliverable(d: Deliverable): Promise<Deliverable> {
  if (!_db) throw new Error("Database not connected");
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `UPSERT deliverable:${d.id} SET
      relatedRunId = $relatedRunId,
      agentId      = $agentId,
      status       = $status,
      feedback     = $feedback,
      score        = $score,
      createdAt    = $createdAt,
      updatedAt    = $updatedAt
    RETURN *`,
    {
      relatedRunId: d.relatedRunId, agentId: d.agentId,
      status: d.status, feedback: d.feedback ?? null, score: d.score ?? null,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    }
  );
  if (!result?.length) throw new Error("UPSERT deliverable failed");
  return rowToDeliverable(result[0]);
}

export async function dbSelectDeliverable(id: string): Promise<Deliverable | null> {
  if (!_db) return null;
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `SELECT * FROM deliverable:${id}`, {}
  );
  return result?.length ? rowToDeliverable(result[0]) : null;
}

export async function dbSelectDeliverablesByRun(runId: string): Promise<Deliverable[]> {
  const rows = await _query<Record<string, unknown>>(
    `SELECT * FROM deliverable WHERE relatedRunId = $runId`, { runId }
  );
  return rows.map(rowToDeliverable);
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

interface DbScorecard {
  scopeKind: string; scopeId: string; metricName: string;
  currentValue: number; targetValue: number; history: ScorecardHistoryEntry[];
}
function rowToScorecard(r: Record<string, unknown>): Scorecard {
  return {
    scopeKind:    String(r.scopeKind ?? ""),
    scopeId:      String(r.scopeId ?? ""),
    metricName:   String(r.metricName ?? ""),
    currentValue: Number(r.currentValue ?? 0),
    targetValue:  Number(r.targetValue ?? 0),
    history:     Array.isArray(r.history) ? r.history as ScorecardHistoryEntry[] : [],
  };
}

export async function dbUpsertScorecard(s: Scorecard): Promise<Scorecard> {
  if (!_db) throw new Error("Database not connected");
  const recordId = `scorecard:${s.scopeKind}:${s.scopeId}:${s.metricName}`;
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `UPSERT ${recordId} SET
      scopeKind    = $scopeKind,
      scopeId      = $scopeId,
      metricName   = $metricName,
      currentValue = $currentValue,
      targetValue  = $targetValue,
      history      = $history
    RETURN *`,
    {
      scopeKind: s.scopeKind, scopeId: s.scopeId, metricName: s.metricName,
      currentValue: s.currentValue, targetValue: s.targetValue, history: s.history,
    }
  );
  if (!result?.length) throw new Error("UPSERT scorecard failed");
  return rowToScorecard(result[0]);
}

export async function dbSelectScorecard(
  scopeKind: string, scopeId: string, metricName: string
): Promise<Scorecard | null> {
  if (!_db) return null;
  const recordId = `scorecard:${scopeKind}:${scopeId}:${metricName}`;
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `SELECT * FROM ${recordId}`, {}
  );
  return result?.length ? rowToScorecard(result[0]) : null;
}

export async function dbAppendScorecardHistory(
  scopeKind: string, scopeId: string, metricName: string, value: number
): Promise<ScorecardHistoryEntry> {
  if (!_db) {
    return { value, timestamp: new Date().toISOString() };
  }
  const existing = await dbSelectScorecard(scopeKind, scopeId, metricName);
  const now = new Date().toISOString();
  const entry: ScorecardHistoryEntry = { value, timestamp: now };
  if (existing) {
    await dbUpsertScorecard({ ...existing, currentValue: value, history: [...existing.history, entry] });
  } else {
    await dbUpsertScorecard({ scopeKind, scopeId, metricName, currentValue: value, targetValue: 1, history: [entry] });
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Retrospective
// ---------------------------------------------------------------------------

interface DbRetro {
  scopeKind: string; scopeId: string;
  linkedDeliverableIds: string[]; keyFindings: string[];
  actionItems: string[]; status: RetrospectiveStatus;
  createdAt: string; updatedAt: string;
}
function rowToRetro(r: Record<string, unknown>): Retrospective {
  return {
    scopeKind:    String(r.scopeKind ?? ""),
    scopeId:      String(r.scopeId ?? ""),
    linkedDeliverableIds: Array.isArray(r.linkedDeliverableIds)
      ? r.linkedDeliverableIds.map(String) : [],
    keyFindings:  Array.isArray(r.keyFindings)  ? r.keyFindings.map(String)  : [],
    actionItems:  Array.isArray(r.actionItems)  ? r.actionItems.map(String)  : [],
    status:       String(r.status ?? "draft") as RetrospectiveStatus,
    createdAt:    String(r.createdAt ?? ""),
    updatedAt:    String(r.updatedAt ?? ""),
  };
}

export async function dbUpsertRetrospective(r: Retrospective): Promise<Retrospective> {
  if (!_db) throw new Error("Database not connected");
  const recordId = `retrospective:${r.scopeKind}:${r.scopeId}`;
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `UPSERT ${recordId} SET
      scopeKind            = $scopeKind,
      scopeId              = $scopeId,
      linkedDeliverableIds = $linkedDeliverableIds,
      keyFindings          = $keyFindings,
      actionItems          = $actionItems,
      status               = $status,
      createdAt            = $createdAt,
      updatedAt            = $updatedAt
    RETURN *`,
    {
      scopeKind: r.scopeKind, scopeId: r.scopeId,
      linkedDeliverableIds: r.linkedDeliverableIds ?? [],
      keyFindings:  r.keyFindings  ?? [],
      actionItems:  r.actionItems  ?? [],
      status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }
  );
  if (!result?.length) throw new Error("UPSERT retrospective failed");
  return rowToRetro(result[0]);
}

export async function dbSelectRetrospective(scopeKind: string, scopeId: string): Promise<Retrospective | null> {
  if (!_db) return null;
  const recordId = `retrospective:${scopeKind}:${scopeId}`;
  const [result] = await _db.query<[Record<string, unknown>[]]>(
    `SELECT * FROM ${recordId}`, {}
  );
  return result?.length ? rowToRetro(result[0]) : null;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function dbAppendAudit(a: AuditEntry): Promise<void> {
  if (!_db) return;
  await _db.query(
    `INSERT INTO audit_entry { action: $action, actorId: $actorId, actorType: $actorType, note: $note, timestamp: $timestamp }`,
    { action: a.action, actorId: a.actorId, actorType: a.actorType, note: a.note ?? null, timestamp: a.timestamp }
  );
}
