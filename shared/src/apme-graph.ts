/**
 * APME graph projection — the row store viewed as a property graph.
 *
 * ## Is the row model graph-shaped?
 *
 * Partly, and the gaps are worth naming because they decide what a graph view
 * can honestly show.
 *
 * What is already a graph: `runs → tasks → turns → sample_events` is a strict
 * containment tree with real foreign keys, and `evals` attach at three of those
 * levels (`run_id` / `task_id` / `turn_id`). That part projects directly.
 *
 * What was NOT, and is repaired at the schema level rather than guessed at here:
 *   - `sample_events` addressed its turn by `turn_index`, an integer unique only
 *     within a run — no event→turn edge existed. Now `sample_events.turn_id`.
 *   - `/clear` opens a fresh run with no pointer to the one it continues, so a
 *     single conversation appeared as N disconnected components (one live
 *     session held 127 runs). Now `runs.parent_run_id`.
 *
 * What is still denormalized, and is therefore DERIVED here rather than read:
 * session, project, model, agent, tool and file are string columns, not rows.
 * They are exactly the interesting hubs — they connect work units that share no
 * ancestor — so this projection materializes them as nodes. That is a deliberate
 * choice: they are cheap to derive, they change meaning as the schema evolves,
 * and promoting them to tables would buy nothing the projection cannot do.
 *
 * File nodes come from tool payloads (`input.file_path` and friends), which is
 * the highest-value cross-link in the store — "which units touched this file"
 * is not answerable any other way — but coverage is partial by nature: only
 * file-taking tools carry one.
 *
 * The projection is read-only and derived on demand. Nothing persists it, so it
 * can be reshaped without a migration.
 */

/** Node kinds. Containment nodes mirror rows; entity nodes are derived hubs. */
export type ApmeGraphNodeKind =
  // ── containment (backed by a row) ──
  | 'run'
  | 'task'
  | 'turn'
  // ── entities (derived from denormalized columns / payloads) ──
  | 'session'
  | 'project'
  | 'model'
  | 'agent'
  | 'tool'
  | 'file';

export type ApmeGraphEdgeKind =
  /** Containment: run→task, task→turn. */
  | 'contains'
  /** run→run across a `/clear` context reset (`parent_run_id`). */
  | 'continues'
  /** session→run, project→run, model→run, agent→run. */
  | 'produced'
  /** turn→tool, task→tool — the turn invoked this tool. */
  | 'used'
  /** turn→file, task→file — the turn read or wrote this path. */
  | 'touched';

export interface ApmeGraphNode {
  /** `${kind}:${naturalKey}` — stable across rebuilds so a client can diff. */
  id: string;
  kind: ApmeGraphNodeKind;
  label: string;
  /** Wall-clock anchor for time-ordered layouts. Null for entity hubs. */
  ts?: number | null;
  /** Judge score where one exists, for weight/colour. */
  score?: number | null;
  /** How many graph edges reference this node — entity hubs are ranked by it. */
  degree?: number;
  /** Kind-specific extras (outcome, category, cost, turn count, …). */
  meta?: Record<string, string | number | null>;
}

export interface ApmeGraphEdge {
  from: string;
  to: string;
  kind: ApmeGraphEdgeKind;
  /** Repetition count for collapsed parallel edges (e.g. 12 Read calls). */
  weight?: number;
}

export interface ApmeGraphSlice {
  nodes: ApmeGraphNode[];
  edges: ApmeGraphEdge[];
  /** What the slice covered and what it deliberately left out, so a viewer
   *  never reads a truncated graph as a complete one. */
  stats: {
    taskCount: number;
    nodeCount: number;
    edgeCount: number;
    /** Tasks matching the filter beyond `limit` — omitted from this slice. */
    truncatedTasks: number;
    /** File nodes are only as complete as the tools that name a path. */
    fileCoverage: { toolEvents: number; withPath: number };
  };
}

export interface ApmeGraphResponse extends ApmeGraphSlice {
  schema: number;
}

/** Node id helpers — one place so producer and consumer cannot drift. */
export const apmeGraphNodeId = {
  run: (id: string) => `run:${id}`,
  task: (id: string) => `task:${id}`,
  turn: (id: string) => `turn:${id}`,
  session: (id: string) => `session:${id}`,
  project: (name: string) => `project:${name}`,
  model: (id: string) => `model:${id}`,
  agent: (t: string) => `agent:${t}`,
  tool: (name: string) => `tool:${name}`,
  file: (path: string) => `file:${path}`,
} as const;
