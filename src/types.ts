/**
 * Core entity types for uos.org-learning plugin.
 */

export type LearningSource = "incident" | "project" | "department" | "connector" | "manual" | "review";
export type LearningStatus = "active" | "archived" | "superseded";
export type LearningPriority = "critical" | "high" | "medium" | "low";

export interface LearningTag {
  name: string;
  source: string;
}

export interface Learning {
  id: string;
  title: string;
  body: string;
  source: LearningSource;
  sourceId?: string;
  sourceName?: string;
  tags: LearningTag[];
  status: LearningStatus;
  priority: LearningPriority;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  /** ID of the learning that supersedes this one (when this learning is stale) */
  supersededBy?: string;
  /** IDs of learnings this one supersedes (when this is an update to prior knowledge) */
  supersedes?: string[];
}

export interface LearningSummary {
  totalLearnings: number;
  bySource: Record<LearningSource, number>;
  byPriority: Record<LearningPriority, number>;
  byStatus: Record<LearningStatus, number>;
  recentCount: number;
}

export interface LearningQuery {
  query?: string;
  sourceId?: string; // filter by exact sourceId match
  sources?: LearningSource[];
  tags?: string[];
  priority?: LearningPriority;
  status?: LearningStatus;
  limit?: number;
}

export interface LearningCreateParams {
  title: string;
  body: string;
  source: LearningSource;
  sourceId?: string;
  sourceName?: string;
  tags?: LearningTag[];
  priority?: LearningPriority;
  createdBy?: string;
}

export interface LearningUpdateParams {
  id: string;
  title?: string;
  body?: string;
  tags?: LearningTag[];
  status?: LearningStatus;
  priority?: LearningPriority;
}

// ---------------------------------------------------------------------------
// LearningArtifact types
// ---------------------------------------------------------------------------

export type ArtifactKind = "knowledge_entry" | "playbook" | "policy";

export interface KnowledgeEntry {
  id: string;
  title: string;
  body: string;
  tags: LearningTag[];
  sourceInfo?: {
    source: LearningSource;
    sourceId?: string;
    sourceName?: string;
  };
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface Playbook {
  id: string;
  title: string;
  body: string;
  tags: LearningTag[];
  sourceInfo?: {
    source: LearningSource;
    sourceId?: string;
    sourceName?: string;
  };
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface Policy {
  id: string;
  title: string;
  body: string;
  tags: LearningTag[];
  sourceInfo?: {
    source: LearningSource;
    sourceId?: string;
    sourceName?: string;
  };
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

// ---------------------------------------------------------------------------
// Deliverable (from agent runs)
// ---------------------------------------------------------------------------

export type DeliverableStatus = "pending_review" | "approved" | "rejected";

export interface Deliverable {
  id: string;
  relatedRunId: string;
  agentId: string;
  status: DeliverableStatus;
  score?: number;
  feedback?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export interface ScorecardHistoryEntry {
  value: number;
  timestamp: string;
}

export interface Scorecard {
  scopeKind: string;
  scopeId: string;
  metricName: string;
  currentValue: number;
  targetValue: number;
  history: ScorecardHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Retrospective
// ---------------------------------------------------------------------------

export type RetrospectiveStatus = "draft" | "pending_review" | "completed";

export interface Retrospective {
  scopeKind: string;
  scopeId: string;
  linkedDeliverableIds: string[];
  keyFindings: string[];
  actionItems: string[];
  status: RetrospectiveStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// AuditEntry
// ---------------------------------------------------------------------------

export type ActorType = "user" | "agent" | "system";

export interface AuditEntry {
  action: string;
  actorId: string;
  actorType: ActorType;
  note?: string;
  timestamp: string;
}
