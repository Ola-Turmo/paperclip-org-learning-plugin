/**
 * Worker for uos.org-learning plugin.
 *
 * All handlers are registered inside the single `setup(ctx)` function:
 *   - Event subscriptions  (agent.run.*, issue.*, approval.*)
 *   - Stream subscriptions  (quality-gate review_updated)
 *   - Scheduled jobs        (weekly retrospective)
 *   - Agent tools           (get-playbooks, search-knowledge, record-learning)
 *   - Data queries          (learning.list, learning.summary, learning.health, …)
 *   - Actions               (learning.create, learning.update, retrospective.create, …)
 *
 * Paperclip integration patterns:
 *   - ctx.streams.emit() after every state mutation → UI widgets refresh in real-time
 *   - ctx.issues.* to enrich learnings from issue context
 *   - ctx.activity.log() for audit trail (wrapped in try/catch — degrades gracefully)
 *   - ctx.data.register() for queryable endpoints
 *   - ctx.actions.register() for write operations
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginEvent,
  PluginJobContext,
  ToolResult,
} from "@paperclipai/plugin-sdk";

import {
  PLUGIN_ID,
  JOB_KEYS,
  TOOL_KEYS,
  DATA_KEYS,
  ACTION_KEYS,
} from "./constants.js";

import {
  createLearning,
  updateLearning,
  archiveLearning,
  queryLearnings,
  queryLearningsWithRanking,
  computeSummary,
  computeHealth,
  getLearningsBySource,
  searchPlaybooks,
  createPlaybook,
  createDeliverable,
  approveDeliverable,
  rejectDeliverable,
  createOrUpdateRetrospective,
  getRetrospective,
  seedDemoLearnings,
  rehydrateFromDb,
  supersedeLearning,
} from "./helpers.js";

import type {
  LearningQuery,
  LearningCreateParams,
  RetrospectiveStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTags(tags?: string | string[]): { name: string; source: string }[] {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : tags.split(",").map((t) => t.trim());
  return arr.map((name) => ({ name, source: "manual" }));
}

function normalizePriority(p?: string): "critical" | "high" | "medium" | "low" {
  if (p === "critical" || p === "high" || p === "low") return p;
  return "medium";
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Setting up uos.org-learning plugin");

    // Rehydrate from SurrealDB if connected
    await rehydrateFromDb();

    // -------------------------------------------------------------------------
    // Event subscriptions
    // -------------------------------------------------------------------------

    /**
     * agent.run.started — record what this run was trying to do so we can
     * correlate with agent.run.cancelled or agent.run.failed later.
     */
    ctx.events.on("agent.run.started", async (event: PluginEvent) => {
      const runId = event.entityId ?? "unknown";
      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.agentId as string) ?? "unknown";
      const goalTitle = (payload?.goalTitle as string) ?? `Run ${runId}`;

      // Store minimal context for later correlation on cancel/fail
      await ctx.state.set(
        { scopeKind: "run", scopeId: runId, stateKey: "runContext" },
        { agentId, goalTitle, startedAt: new Date().toISOString() } as Record<string, string>,
      );

      ctx.logger.info("agent.run.started observed", { runId, agentId, goalTitle });
    });

    /**
     * agent.run.finished — create a deliverable record for this run.
     * If the run failed, create a learning capturing the failure.
     *
     * NOTE: do NOT create a learning here for failed runs if agent.run.failed
     * also fires for the same run — that would create duplicates.
     * agent.run.failed only logs; the learning is created here exclusively.
     */
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const runId = event.entityId ?? "unknown";
      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.agentId as string) ?? "unknown";
      const runStatus = (payload?.status as string) ?? "unknown";

      // Always create a deliverable so the run is traceable
      const d = await createDeliverable({ relatedRunId: runId, agentId });
      ctx.events.emit("learning_updated", event.companyId, { entityType: "deliverable", entityId: d.id });

      if (runStatus === "failed") {
        // Retrieve stored context from agent.run.started to enrich the learning
        const runContext = (await ctx.state.get(
          { scopeKind: "run", scopeId: runId, stateKey: "runContext" }
        )) as { goalTitle?: string; agentId?: string } | null;
        const goalTitle = runContext?.goalTitle ?? `Run ${runId}`;

        // Check for an existing learning for this run — if found, supersede it
        const existing = queryLearnings({ sourceId: runId, limit: 1 });

        const learningParams = {
          title: `Run failed: ${goalTitle}`,
          body: [
            `Agent run '${runId}' completed with status '${runStatus}'.`,
            `Agent: ${agentId}`,
            `Goal: ${goalTitle}`,
            `Review the run logs and capture lessons learned.`,
            `Failure mode: See run logs at https://app.paperclip.ai/runs/${runId}`,
          ].join("\n"),
          source: "manual" as const,
          sourceId: runId,
          sourceName: `Agent ${agentId}`,
          priority: "high" as const,
          tags: [
            { name: "agent-run", source: "system" },
            { name: "failed", source: "system" },
          ],
          createdBy: "org-learning-plugin",
        };

        let learningId: string;
        if (existing.length > 0) {
          // Supersede the existing learning with an updated version
          const result = await supersedeLearning(existing[0].id, learningParams);
          learningId = result!.new.id;
        } else {
          const learning = await createLearning(learningParams);
          learningId = learning.id;
        }

        ctx.streams.emit("uos.org-learning.learning_created", { learningId });

        try {
          await ctx.activity.log({
            companyId: event.companyId,
            message: `Run ${runId} failed — learning ${learningId} created`,
            entityType: "run",
            entityId: runId,
          });
        } catch {
          // activity not available
        }
      }

      ctx.logger.info("agent.run.finished observed", { runId, agentId, runStatus });
    });

    /**
     * agent.run.failed — only fires when the run crashes/fails to start.
     * Do NOT create a duplicate learning here — agent.run.finished already
     * handles failed runs. Just log for observability.
     */
    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const runId = event.entityId ?? "unknown";
      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.agentId as string) ?? "unknown";
      const error = (payload?.error as string) ?? "unknown error";

      // Retrieve stored context to capture what was being attempted
      const runContext = (await ctx.state.get(
        { scopeKind: "run", scopeId: runId, stateKey: "runContext" }
      )) as { goalTitle?: string; agentId?: string } | null;
      const goalTitle = runContext?.goalTitle ?? runId;

      const learning = await createLearning({
        title: `Run crashed: ${goalTitle}`,
        body: [
          `Agent run '${runId}' crashed before completion.`,
          `Agent: ${agentId}`,
          `Goal: ${goalTitle}`,
          `Error: ${error}`,
          `Capture the root cause and add action items to prevent recurrence.`,
        ].join("\n"),
        source: "manual",
        sourceId: runId,
        sourceName: `Agent ${agentId}`,
        priority: "critical",
        tags: [
          { name: "agent-run", source: "system" },
          { name: "crash", source: "system" },
        ],
        createdBy: "org-learning-plugin",
      });

      ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
      ctx.logger.info("agent.run.failed observed — learning created", { runId, agentId, error });
    });

    /**
     * agent.run.cancelled — capture why a run was cancelled so it can be
     * turned into a learning about resource management or premature termination.
     */
    ctx.events.on("agent.run.cancelled", async (event: PluginEvent) => {
      const runId = event.entityId ?? "unknown";
      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.agentId as string) ?? "unknown";
      const reason = (payload?.reason as string) ?? "No reason provided";

      const runContext = (await ctx.state.get(
        { scopeKind: "run", scopeId: runId, stateKey: "runContext" }
      )) as { goalTitle?: string; agentId?: string } | null;
      const goalTitle = runContext?.goalTitle ?? runId;

      const learning = await createLearning({
        title: `Run cancelled: ${goalTitle}`,
        body: [
          `Agent run '${runId}' was cancelled.`,
          `Agent: ${agentId}`,
          `Goal: ${goalTitle}`,
          `Cancellation reason: ${reason}`,
          `If this was unexpected, investigate whether the run was terminated prematurely.`,
        ].join("\n"),
        source: "manual",
        sourceId: runId,
        sourceName: `Agent ${agentId}`,
        priority: "medium",
        tags: [
          { name: "agent-run", source: "system" },
          { name: "cancelled", source: "system" },
        ],
        createdBy: "org-learning-plugin",
      });

      ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
      ctx.logger.info("agent.run.cancelled observed", { runId, agentId, reason });
    });

    /**
     * issue.created — fetch full issue details via ctx.issues.get() to create
     * a richer learning than just the title field in the event payload.
     */
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const issueId = event.entityId ?? "unknown";
      const companyId = event.companyId;

      await ctx.state.set(
        { scopeKind: "issue", scopeId: issueId, stateKey: "seen" },
        true,
      );

      // Enrich with full issue context from ctx.issues
      let issueTitle = issueId;
      let issueBody = "";
      try {
        const issue = await ctx.issues.get(issueId, companyId);
        if (issue) {
          issueTitle = issue.title ?? issueTitle;
          issueBody = issue.description ?? "";
        }
      } catch {
        // ctx.issues not available — fall back to payload title
      }

      const learning = await createLearning({
        title: `Issue tracked: ${issueTitle}`,
        body: issueBody
          ? `Issue '${issueTitle}' (${issueId}) was created.\n\n## Description\n${issueBody}\n\nA retrospective will be created when this issue is resolved.`
          : `Issue '${issueTitle}' (${issueId}) was created. When resolved, a retrospective will capture lessons learned.`,
        source: "manual",
        sourceId: issueId,
        sourceName: issueTitle,
        priority: "medium",
        tags: [{ name: "issue", source: "system" }],
        createdBy: "org-learning-plugin",
      });

      ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
      ctx.logger.info("issue.created observed", { issueId });
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      const issueId = event.entityId ?? "unknown";
      const payload = event.payload as Record<string, unknown>;
      const comment = (payload?.comment as string) ?? "";

      // Magic keywords in comments trigger learning ingestion
      if (
        comment.includes("@org-learning record") ||
        comment.includes("record learning") ||
        comment.includes("@learning add")
      ) {
        ctx.logger.info("Learning record trigger detected in comment", { issueId });
        // The INGEST_FROM_EVENT action can be called by the agent when it sees this event
      }
    });

    /**
     * approval.created — track that an approval is pending; when decided,
     * approval.decided will capture the outcome.
     */
    ctx.events.on("approval.created", async (event: PluginEvent) => {
      const approvalId = event.entityId ?? "unknown";
      const payload = event.payload as Record<string, unknown>;
      const requestedFor = (payload?.requestedFor as string) ?? "unknown";

      const learning = await createLearning({
        title: `Approval pending: ${approvalId}`,
        body: `An approval request (${approvalId}) is awaiting decision for '${requestedFor}'. Decision outcomes are captured as learnings.`,
        source: "manual",
        sourceId: approvalId,
        sourceName: requestedFor,
        priority: "medium",
        tags: [{ name: "approval", source: "system" }],
        createdBy: "org-learning-plugin",
      });

      ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
      ctx.logger.info("approval.created observed", { approvalId, requestedFor });
    });

    ctx.events.on("approval.decided", async (event: PluginEvent) => {
      const approvalId = event.entityId ?? "unknown";
      const payload = event.payload as Record<string, unknown>;
      const decision = (payload?.decision as string) ?? "unknown";
      const decidedBy = (payload?.decidedBy as string) ?? "unknown";

      const learning = await createLearning({
        title: `Approval ${decision}: ${approvalId}`,
        body: `Approval ${approvalId} was ${decision} by ${decidedBy}. Outcome captured for future reference.`,
        source: "manual",
        sourceId: approvalId,
        priority: decision === "rejected" ? "high" : "low",
        tags: [
          { name: "approval", source: "system" },
          { name: decision, source: "system" },
        ],
        createdBy: "org-learning-plugin",
      });

      ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
      ctx.logger.info("approval.decided observed", { approvalId, decision, decidedBy });
    });

    // -------------------------------------------------------------------------
    // Stream subscriptions (from other plugins)
    // -------------------------------------------------------------------------

    // NOTE: Subscribing to quality-gate's "review_updated" stream is not supported
    // via ctx.streams.on() — PluginStreamsClient only has emit/open, no subscribe.
    // The quality-gate integration is handled via ctx.events.emit() calls in
    // the quality-gate plugin, which this plugin receives through agent.run.finished
    // events. If tighter coupling is needed, emit a plugin-namespaced event here
    // that quality-gate can subscribe to via ctx.events.on("plugin.uos.org-learning.*").

    // -------------------------------------------------------------------------
    // Scheduled jobs
    // -------------------------------------------------------------------------

    ctx.jobs.register(
      JOB_KEYS.WEEKLY_RETROSPECTIVE,
      async (job: PluginJobContext) => {
        ctx.logger.info("Running weekly retrospective job", { jobKey: job.jobKey });

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Fetch resolved issues via ctx.issues — note: requires companyId which is
        // only available in event context, not job context. For now, fall back to
        // learnings-only retrospective. Once the plugin supports per-company
        // initialization with companyId, this can be re-enabled.
        let resolvedIssueIds: string[] = [];
        try {
          const issues = await ctx.issues.list({
            companyId: "instance",
            status: "done",
            limit: 50,
          });
          resolvedIssueIds = issues.map((i: { id: string }) => i.id);
        } catch {
          // ctx.issues not available — fall back to learnings-only retro
        }

        const allActive = queryLearnings({ status: "active", limit: 100 });
        const recentLearnings = allActive.filter(
          (l) => new Date(l.createdAt) >= sevenDaysAgo,
        );

        const highPriority = recentLearnings.filter(
          (l) => l.priority === "high" || l.priority === "critical",
        );
        const bySource = new Map<string, number>();
        for (const l of recentLearnings) {
          bySource.set(l.source, (bySource.get(l.source) ?? 0) + 1);
        }

        const summaryLines = [
          `## Weekly Learning Summary`,
          `Generated: ${new Date().toISOString()}`,
          ``,
          `Total active learnings: ${recentLearnings.length}`,
          `High/critical priority: ${highPriority.length}`,
          `Resolved issues reviewed: ${resolvedIssueIds.length}`,
          ``,
          `### By Source`,
          ...Array.from(bySource.entries()).map(
            ([src, count]) => `- ${src}: ${count}`,
          ),
        ];

        const retro = await createOrUpdateRetrospective({
          scopeKind: "company",
          scopeId: "weekly-retro",
          keyFindings: highPriority.map((l) => l.title),
          actionItems: [
            ...highPriority.map((l) => `Review: ${l.title} (${l.sourceId ?? l.id})`),
            ...resolvedIssueIds.slice(0, 5).map((id) => `Close out issue: ${id}`),
          ],
          status: "draft",
        });

        ctx.streams.emit("uos.org-learning.learning_updated", { entityType: "retrospective", entityId: retro.scopeId });

        try {
          await ctx.activity.log({
            companyId: "instance",
            message: `Weekly retrospective completed. ${recentLearnings.length} learnings reviewed.`,
            metadata: { summaryLines, retrospectiveId: retro.scopeId },
          });
        } catch {
          // activity not available
        }

        ctx.logger.info("Weekly retrospective job complete", {
          totalLearnings: recentLearnings.length,
          highPriorityCount: highPriority.length,
          retrospectiveId: retro.scopeId,
        });
      },
    );

    // -------------------------------------------------------------------------
    // Agent tools
    // -------------------------------------------------------------------------

    ctx.tools.register(
      TOOL_KEYS.GET_PLAYBOOKS,
      {
        displayName: "Get Playbooks",
        description:
          "Returns predefined playbooks relevant to the current context.",
        parametersSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional free-text query to filter playbooks.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tag filter.",
            },
          },
        },
      },
      async (params: unknown): Promise<ToolResult> => {
        const p = params as { query?: string; tags?: string[] };
        const results = searchPlaybooks(p.query, p.tags);
        return {
          content: JSON.stringify({ playbooks: results, count: results.length }),
        };
      },
    );

    ctx.tools.register(
      TOOL_KEYS.SEARCH_KNOWLEDGE,
      {
        displayName: "Search Knowledge Base",
        description:
          "Search the organizational knowledge base using BM25-ranked full-text search across all learnings, playbooks, and policies.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free-text search query — searches title, body, and tags." },
            sources: {
              type: "array",
              items: { type: "string" },
              description: "Optional source filter: 'incident', 'manual', 'approval', 'project'.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tag filter.",
            },
            limit: {
              type: "number",
              description: "Maximum results. Defaults to 10.",
            },
          },
        },
      },
      async (params: unknown): Promise<ToolResult> => {
        const p = params as {
          query?: string;
          sources?: string[];
          tags?: string[];
          limit?: number;
        };
        // Use BM25-ranked async query when a text query is provided
        const results = p.query
          ? await queryLearningsWithRanking({
              query: p.query,
              sources: p.sources as LearningQuery["sources"],
              tags: p.tags,
              limit: p.limit ?? 10,
            })
          : queryLearnings({
              sources: p.sources as LearningQuery["sources"],
              tags: p.tags,
              limit: p.limit ?? 10,
            });
        return {
          content: JSON.stringify({ learnings: results, count: results.length }),
        };
      },
    );

    ctx.tools.register(
      TOOL_KEYS.RECORD_LEARNING,
      {
        displayName: "Record Learning",
        description: "Records a new learning artifact (knowledge entry, playbook, or policy).",
        parametersSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["knowledge_entry", "playbook", "policy"],
              description: "Kind of artifact.",
            },
            title: {
              type: "string",
              description: "Short descriptive title (max 120 chars).",
            },
            body: { type: "string", description: "Full content of the artifact." },
            source: {
              type: "string",
              description: "Source: 'incident', 'manual', 'approval', 'agent_run', 'project'.",
            },
            sourceId: { type: "string", description: "Optional source entity ID." },
            priority: {
              type: "string",
              enum: ["critical", "high", "medium", "low"],
              description: "Priority.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags.",
            },
          },
          required: ["kind", "title", "body", "source"],
        },
      },
      async (params: unknown): Promise<ToolResult> => {
        const p = params as {
          kind?: string;
          title?: string;
          body?: string;
          source?: string;
          sourceId?: string;
          priority?: string;
          tags?: string | string[];
        };

        const title = String(p.title ?? "").slice(0, 120);
        const body = String(p.body ?? "");

        if (!title || !body) {
          return { error: "title and body are required" };
        }

        if (p.kind === "playbook") {
          const playbook = await createPlaybook({
            title,
            body,
            tags: parseTags(p.tags),
            source: p.source as LearningCreateParams["source"],
            sourceId: p.sourceId,
            createdBy: "agent",
          });
          ctx.streams.emit("uos.org-learning.learning_updated", { entityType: "playbook", entityId: playbook.id });
          return {
            content: JSON.stringify({
              id: playbook.id,
              title: playbook.title,
              kind: "playbook",
            }),
          };
        }

        if (p.kind === "policy") {
          const learning = await createLearning({
            title,
            body,
            source: (p.source as LearningCreateParams["source"]) ?? "manual",
            sourceId: p.sourceId,
            priority: normalizePriority(p.priority),
            tags: [...parseTags(p.tags), { name: "policy", source: "system" }],
            createdBy: "agent",
          });
          ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
          return {
            content: JSON.stringify({
              id: learning.id,
              title: learning.title,
              kind: "policy",
            }),
          };
        }

        // Default: knowledge_entry
        const learning = await createLearning({
          title,
          body,
          source: (p.source as LearningCreateParams["source"]) ?? "manual",
          sourceId: p.sourceId,
          priority: normalizePriority(p.priority),
          tags: parseTags(p.tags),
          createdBy: "agent",
        });
        ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
        return {
          content: JSON.stringify({
            id: learning.id,
            title: learning.title,
            kind: "knowledge_entry",
          }),
        };
      },
    );

    // -------------------------------------------------------------------------
    // Data queries (read-side — stateless)
    // -------------------------------------------------------------------------

    ctx.data.register(
      DATA_KEYS.LEARNING_LIST,
      async (params: Record<string, unknown>) => {
        const limit = typeof params.limit === "number" ? params.limit : 20;
        const learnings = queryLearnings({ status: "active", limit });
        return { learnings };
      },
    );

    ctx.data.register(DATA_KEYS.LEARNING_SUMMARY, async () => {
      return computeSummary();
    });

    ctx.data.register(
      DATA_KEYS.LEARNING_BY_SOURCE,
      async (params: Record<string, unknown>) => {
        const source = params.source as LearningCreateParams["source"];
        const learnings = getLearningsBySource(source, 50);
        return { learnings, count: learnings.length };
      },
    );

    // Note: DATA_KEYS.HEALTH === "learning.health" — registered by key, not string literal
    ctx.data.register(DATA_KEYS.HEALTH, async () => {
      return computeHealth();
    });

    ctx.data.register(
      "retrospective.get",
      async (params: Record<string, unknown>) => {
        const scopeKind = String(params.scopeKind ?? "issue");
        const scopeId = String(params.scopeId ?? "");
        const retro = getRetrospective(scopeKind, scopeId);
        return { retrospective: retro };
      },
    );

    ctx.data.register(
      "playbooks.search",
      async (params: Record<string, unknown>) => {
        const query =
          typeof params.query === "string" ? params.query : undefined;
        const tags = Array.isArray(params.tags)
          ? params.tags.map(String)
          : undefined;
        const results = searchPlaybooks(query, tags);
        return { playbooks: results, count: results.length };
      },
    );

    // -------------------------------------------------------------------------
    // Actions (write-side — emit stream events so UI refreshes in real-time)
    // -------------------------------------------------------------------------

    ctx.actions.register(
      ACTION_KEYS.CREATE_LEARNING,
      async (params: Record<string, unknown>) => {
        const p = params as unknown as LearningCreateParams;
        const learning = await createLearning(p);
        ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
        return { success: true, learning };
      },
    );

    ctx.actions.register(
      ACTION_KEYS.UPDATE_LEARNING,
      async (params: Record<string, unknown>) => {
        const { id, ...rest } = params as {
          id: string;
        } & Partial<LearningCreateParams>;
        const updated = await updateLearning({ id, ...rest });
        if (!updated) return { success: false, error: "Not found" };
        ctx.streams.emit("uos.org-learning.learning_updated", { learningId: id });
        return { success: true, learning: updated };
      },
    );

    ctx.actions.register(
      ACTION_KEYS.ARCHIVE_LEARNING,
      async (params: Record<string, unknown>) => {
        const { id } = params as { id: string };
        const archived = await archiveLearning(id);
        if (!archived) return { success: false, error: "Not found" };
        ctx.streams.emit("uos.org-learning.learning_updated", { learningId: id });
        return { success: true, learning: archived };
      },
    );

    ctx.actions.register(
      ACTION_KEYS.QUERY_LEARNINGS,
      async (params: Record<string, unknown>) => {
        const q = params as unknown as LearningQuery;
        const results = queryLearnings(q);
        return { learnings: results, count: results.length };
      },
    );

    ctx.actions.register(
      ACTION_KEYS.INGEST_FROM_EVENT,
      async (params: Record<string, unknown>) => {
        const source = (params.source as LearningCreateParams["source"]) ?? "manual";
        const learning = await createLearning({
          title: String(params.title ?? "Untitled"),
          body: String(params.body ?? ""),
          source,
          sourceId: params.sourceId as string | undefined,
          sourceName: params.sourceName as string | undefined,
          priority: normalizePriority(params.priority as string),
          tags: parseTags(params.tags as string | string[] | undefined),
          createdBy: params.createdBy as string | undefined,
        });
        ctx.streams.emit("uos.org-learning.learning_created", { learningId: learning.id });
        return { success: true, learning };
      },
    );

    ctx.actions.register(
      "retrospective.create",
      async (params: Record<string, unknown>) => {
        const scopeKind = String(params.scopeKind ?? "issue");
        const scopeId = String(params.scopeId ?? "");
        const retro = await createOrUpdateRetrospective({
          scopeKind,
          scopeId,
          keyFindings: Array.isArray(params.keyFindings)
            ? params.keyFindings.map(String)
            : undefined,
          actionItems: Array.isArray(params.actionItems)
            ? params.actionItems.map(String)
            : undefined,
          status: (params.status as RetrospectiveStatus) ?? "draft",
        });
        ctx.streams.emit("uos.org-learning.learning_updated", { entityType: "retrospective", entityId: retro.scopeId });
        return { success: true, retrospective: retro };
      },
    );

    ctx.actions.register(
      "deliverable.approve",
      async (params: Record<string, unknown>) => {
        const { id, feedback } = params as { id: string; feedback?: string };
        const d = await approveDeliverable(id, feedback);
        if (!d) return { success: false, error: "Not found" };
        ctx.streams.emit("uos.org-learning.learning_updated", { entityType: "deliverable", entityId: id });
        return { success: true, deliverable: d };
      },
    );

    ctx.actions.register(
      "deliverable.reject",
      async (params: Record<string, unknown>) => {
        const { id, feedback } = params as { id: string; feedback?: string };
        const d = await rejectDeliverable(id, feedback);
        if (!d) return { success: false, error: "Not found" };
        ctx.streams.emit("uos.org-learning.learning_updated", { entityType: "deliverable", entityId: id });
        return { success: true, deliverable: d };
      },
    );

    // -------------------------------------------------------------------------
    // Setup: seed demo data
    // -------------------------------------------------------------------------

    await seedDemoLearnings();
    ctx.logger.info("Plugin setup complete — demo data seeded");
  },

  // ---------------------------------------------------------------------------
  // Plugin health check — called by the Paperclip host to determine if this
  // plugin is healthy and should remain in the active plugin list.
  // ---------------------------------------------------------------------------
  async onHealth() {
    const health = computeHealth();
    return {
      status: health.status,
      message: health.message ?? "OK",
      checkedAt: health.checkedAt,
    };
  },
});

runWorker(plugin, import.meta.url);
