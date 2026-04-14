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
