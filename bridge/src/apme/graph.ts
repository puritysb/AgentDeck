/**
 * Projects APME rows into a property graph (see shared/src/apme-graph.ts for
 * the model and for what the row schema does and does not already express).
 *
 * Derived on demand, never persisted: the containment spine comes straight from
 * foreign keys, while session / project / model / agent / tool / file hubs are
 * materialized from denormalized columns and tool payloads. Those hubs are the
 * reason this exists — they are the only edges that connect work units sharing
 * no ancestor.
 */

import type {
  ApmeGraphEdge, ApmeGraphEdgeKind, ApmeGraphNode, ApmeGraphSlice,
} from '@agentdeck/shared';
import { apmeGraphNodeId as nid } from '@agentdeck/shared';
import type { ApmeStore } from './store.js';

export interface ApmeGraphOptions {
  /** Task units to include, newest first. The graph is anchored on tasks
   *  because they are the canonical work unit. */
  limit?: number;
  agentType?: string;
  projectName?: string;
  category?: string;
  /** Include turn nodes and their tool/file edges. Off keeps the slice at
   *  run/task altitude, which is what a whole-history overview wants. */
  includeTurns?: boolean;
  /** Include file nodes derived from tool payloads. */
  includeFiles?: boolean;
  /** Drop tool/file hubs referenced fewer than this many times — the long tail
   *  of one-off paths otherwise buries the structure. */
  minHubDegree?: number;
}

/** Tool-input keys that name a filesystem path, in priority order. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'file'] as const;

/** Pull a file path out of a stored tool payload. Returns null for tools that
 *  do not take one (Bash, WebFetch, …) — partial coverage is expected, and the
 *  slice reports it rather than implying every tool touched a file. */
export function filePathFromToolPayload(payload: string | null | undefined): string | null {
  if (!payload) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const input = (parsed as Record<string, unknown>).input;
  const src = (input && typeof input === 'object' ? input : parsed) as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Identify a file by its path relative to the run's project root, so the same
 *  file edited from a git worktree and from the main checkout lands on ONE node.
 *
 *  The project root is what makes this correct rather than lucky: a fixed
 *  "last N segments" rule merges two checkouts only when their repo-relative
 *  paths happen to be exactly N deep, and quietly splits the node otherwise
 *  (`.../AgentDeck/src/a.ts` vs `.../__worktrees/wt1/src/a.ts` — same file,
 *  different tails). Worktrees are routine here, so that failure would be too.
 *
 *  With no known root — or a path outside it, like a system header — fall back
 *  to the last three segments: unambiguous enough to read, short enough to
 *  render, and it never claims two paths are the same file. */
export function shortenPath(path: string, projectPath?: string | null): string {
  if (projectPath) {
    const root = projectPath.endsWith('/') ? projectPath : projectPath + '/';
    if (path.startsWith(root)) return path.slice(root.length);
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 3 ? parts.join('/') : parts.slice(-3).join('/');
}

class GraphBuilder {
  private readonly nodes = new Map<string, ApmeGraphNode>();
  private readonly edges = new Map<string, ApmeGraphEdge>();

  node(n: ApmeGraphNode): string {
    const existing = this.nodes.get(n.id);
    if (existing) {
      // First writer wins on labels; later mentions only enrich empty fields so
      // a hub referenced from many rows keeps one stable identity.
      if (existing.ts == null && n.ts != null) existing.ts = n.ts;
      if (existing.score == null && n.score != null) existing.score = n.score;
      return n.id;
    }
    this.nodes.set(n.id, n);
    return n.id;
  }

  edge(from: string, to: string, kind: ApmeGraphEdgeKind): void {
    const key = `${from}|${to}|${kind}`;
    const existing = this.edges.get(key);
    // Parallel edges collapse into one weighted edge — 12 Read calls on the
    // same file is one relationship of strength 12, not 12 relationships.
    if (existing) { existing.weight = (existing.weight ?? 1) + 1; return; }
    this.edges.set(key, { from, to, kind, weight: 1 });
  }

  /** Drop low-degree hubs and any edge left dangling by that removal.
   *  Containment nodes are never pruned — they are the slice's subject. */
  pruneHubs(minDegree: number): void {
    if (minDegree <= 1) return;
    const degree = new Map<string, number>();
    for (const e of this.edges.values()) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const prunable = new Set(['tool', 'file']);
    const dropped = new Set<string>();
    for (const n of this.nodes.values()) {
      if (prunable.has(n.kind) && (degree.get(n.id) ?? 0) < minDegree) {
        dropped.add(n.id);
        this.nodes.delete(n.id);
      }
    }
    if (dropped.size === 0) return;
    for (const [key, e] of this.edges) {
      if (dropped.has(e.from) || dropped.has(e.to)) this.edges.delete(key);
    }
  }

  finish(): { nodes: ApmeGraphNode[]; edges: ApmeGraphEdge[] } {
    const degree = new Map<string, number>();
    for (const e of this.edges.values()) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const nodes = [...this.nodes.values()].map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
    return { nodes, edges: [...this.edges.values()] };
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Build a graph slice anchored on the most recent task units. */
export function buildApmeGraph(store: ApmeStore, opts: ApmeGraphOptions = {}): ApmeGraphSlice {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 400);
  const includeTurns = opts.includeTurns ?? true;
  const includeFiles = opts.includeFiles ?? true;
  const minHubDegree = Math.max(opts.minHubDegree ?? 2, 1);

  const page = store.listTaskPage({
    limit,
    ...(opts.agentType ? { agentType: opts.agentType } : {}),
    ...(opts.projectName ? { projectName: opts.projectName } : {}),
    ...(opts.category ? { category: opts.category } : {}),
  });

  const g = new GraphBuilder();
  let toolEvents = 0;
  let toolEventsWithPath = 0;

  for (const t of page.tasks) {
    const runId = t.runId;
    const runNode = g.node({
      id: nid.run(runId), kind: 'run', label: runId.slice(0, 8),
      ts: t.startedAt,
      meta: { project: t.projectName, agent: t.agentType, model: t.modelId },
    });
    const taskNode = g.node({
      id: nid.task(t.id), kind: 'task',
      label: (t.summary || t.firstPrompt || `Task ${t.taskIndex}`).slice(0, 60),
      ts: t.startedAt,
      score: t.overallScore,
      meta: {
        outcome: t.outcome ?? null,
        category: t.taskCategory ?? null,
        boundary: t.boundarySignal ?? null,
        turns: t.turnCount,
        answered: t.answeredTurns,
        tools: t.toolCount,
        cost: t.costUsd ?? null,
      },
    });
    g.edge(runNode, taskNode, 'contains');

    // ── Derived entity hubs ──
    g.edge(g.node({ id: nid.session(t.sessionId), kind: 'session', label: t.sessionId.slice(0, 12) }), runNode, 'produced');
    g.edge(g.node({ id: nid.agent(t.agentType), kind: 'agent', label: t.agentType }), runNode, 'produced');
    if (t.projectName) {
      g.edge(g.node({ id: nid.project(t.projectName), kind: 'project', label: t.projectName }), runNode, 'produced');
    }
    if (t.modelId) {
      g.edge(g.node({ id: nid.model(t.modelId), kind: 'model', label: t.modelId }), runNode, 'produced');
    }
    // `/clear` continuation. The parent run is only drawn when it is already in
    // the slice — a stub node for an out-of-slice run would read as real work.
    if (t.parentRunId && page.tasks.some((o) => o.runId === t.parentRunId)) {
      g.edge(nid.run(t.parentRunId), runNode, 'continues');
    }

    // ── Trajectory: tools and files ──
    const events = store.listSampleEventRows(t.id);
    for (const ev of events) {
      if (ev.kind !== 'tool') continue;
      toolEvents++;
      const toolName = str(ev.toolName);
      const turnId = str(ev.turnId);
      // Attach to the turn when we have one and turns are shown; otherwise the
      // task carries the relationship so the edge is never silently dropped.
      let anchor = taskNode;
      if (includeTurns && turnId) {
        anchor = g.node({
          id: nid.turn(turnId), kind: 'turn',
          label: `turn ${ev.turnIndex ?? '?'}`,
          ts: ev.ts,
          meta: { index: num(ev.turnIndex) },
        });
        g.edge(taskNode, anchor, 'contains');
      }
      if (toolName) {
        g.edge(anchor, g.node({ id: nid.tool(toolName), kind: 'tool', label: toolName }), 'used');
      }
      const path = filePathFromToolPayload(ev.payload);
      if (path) toolEventsWithPath++;
      if (path && includeFiles) {
        const short = shortenPath(path, t.projectPath);
        g.edge(anchor, g.node({ id: nid.file(short), kind: 'file', label: short, meta: { full: path } }), 'touched');
      }
    }
  }

  g.pruneHubs(minHubDegree);
  const { nodes, edges } = g.finish();
  return {
    nodes,
    edges,
    stats: {
      taskCount: page.tasks.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      truncatedTasks: Math.max(0, page.total - page.tasks.length),
      fileCoverage: { toolEvents, withPath: toolEventsWithPath },
    },
  };
}
