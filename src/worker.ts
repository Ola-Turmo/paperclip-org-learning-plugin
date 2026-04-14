/**
 * Worker entry point — registers data queries, actions, and tools.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import {
  createLearning,
  updateLearning,
  archiveLearning,
  queryLearnings,
  getLearningById,
  computeSummary,
  computeHealth,
  seedDemoLearnings,
} from "./helpers.js";

import type {
  LearningQuery,
  LearningCreateParams,
  LearningUpdateParams,
} from "./types.js";

import { DATA_KEYS, ACTION_KEYS } from "./constants.js";

const plugin = definePlugin({
  async setup(ctx) {
    // Seed demo learnings on first setup so the dashboard isn't empty
    seedDemoLearnings();

    // -------------------------------------------------------------------------
    // Event subscriptions
    // -------------------------------------------------------------------------
    ctx.events.on("issue.created", async (event) => {
      const issueId = event.entityId ?? "unknown";
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "seen" }, true);
      ctx.logger.info("Observed issue.created", { issueId });
    });

    // -------------------------------------------------------------------------
    // Data queries
    // -------------------------------------------------------------------------

    ctx.data.register(DATA_KEYS.LEARNING_LIST, async (params) => {
      const q = params as unknown as LearningQuery;
      return queryLearnings(q ?? {});
    });

    ctx.data.register(DATA_KEYS.LEARNING_SUMMARY, async () => {
      return computeSummary();
    });

    ctx.data.register(DATA_KEYS.LEARNING_BY_SOURCE, async (params) => {
      const { source } = params as { source: string };
      const learnings = queryLearnings({ sources: [source as never], status: "active" });
      return { source, learnings, count: learnings.length };
    });

    ctx.data.register(DATA_KEYS.HEALTH, async () => {
      return computeHealth();
    });

    // -------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------

    ctx.actions.register(ACTION_KEYS.CREATE_LEARNING, async (params) => {
      const p = params as unknown as LearningCreateParams;
      if (!p.title || !p.body || !p.source) {
        throw new Error("title, body, and source are required");
      }
      return createLearning(p);
    });

    ctx.actions.register(ACTION_KEYS.UPDATE_LEARNING, async (params) => {
      const p = params as unknown as LearningUpdateParams;
      if (!p.id) throw new Error("id is required");
      const updated = updateLearning(p);
      if (!updated) throw new Error(`Learning not found: ${p.id}`);
      return updated;
    });

    ctx.actions.register(ACTION_KEYS.ARCHIVE_LEARNING, async (params) => {
      const { id } = params as { id: string };
      if (!id) throw new Error("id is required");
      const archived = archiveLearning(id);
      if (!archived) throw new Error(`Learning not found: ${id}`);
      return archived;
    });

    ctx.actions.register(ACTION_KEYS.QUERY_LEARNINGS, async (params) => {
      const q = params as unknown as LearningQuery;
      return queryLearnings(q ?? {});
    });

    ctx.actions.register(ACTION_KEYS.INGEST_FROM_EVENT, async (params) => {
      const { eventKind, entityId, title, body, source, priority } = params as {
        eventKind: string;
        entityId?: string;
        title: string;
        body: string;
        source: string;
        priority?: string;
      };
      return createLearning({
        title,
        body,
        source: source as never,
        sourceId: entityId,
        priority: priority as never,
        createdBy: `ingest:${eventKind}`,
      });
    });
  }
});

runWorker(plugin, import.meta.url);
