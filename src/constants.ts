/**
 * Plugin ID and key constants for uos.org-learning plugin.
 */

export const PLUGIN_ID = "uos.org-learning" as const;

// Event kinds this plugin subscribes to
export const EVENTS_KINDS = [
  "issue.created",
  "incident.created",
  "project.completed",
  "review.submitted",
] as const;

// Data query keys
export const DATA_KEYS = {
  LEARNING_LIST: "learning.list",
  LEARNING_SUMMARY: "learning.summary",
  LEARNING_BY_SOURCE: "learning.bySource",
  HEALTH: "learning.health",
} as const;

// Action keys
export const ACTION_KEYS = {
  CREATE_LEARNING: "learning.create",
  UPDATE_LEARNING: "learning.update",
  ARCHIVE_LEARNING: "learning.archive",
  QUERY_LEARNINGS: "learning.query",
  INGEST_FROM_EVENT: "learning.ingestFromEvent",
} as const;

// Tool keys
export const TOOL_KEYS = {
  SEARCH_LEARNINGS: "learning.search",
  CREATE_LEARNING: "learning.create",
  GET_LEARNING_HEALTH: "learning.health",
} as const;

// UI export names (must match manifest slots)
export const UI_EXPORTS = {
  LEARNING_WIDGET: "LearningWidget",
  LEARNING_HEALTH_WIDGET: "LearningHealthWidget",
} as const;
