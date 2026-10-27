// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/apme-scorecard-sql.ts
// Regenerate: pnpm generate-apme-display-rules (drift gated by shared/src/__tests__/apme-display-rules-sync.test.ts)

enum ApmeScorecardSQL {
    static let ddl = """
    -- Pre-aggregate metrics at the level they actually describe. New rows prefer
    -- turn attribution; runs with no turn identity remain available as a legacy
    -- fallback instead of being silently dropped after the schema migration.
    CREATE VIEW IF NOT EXISTS v_run_metrics AS
    SELECT
      run_id,
      MAX(CASE WHEN metric='overall' AND layer='llm_judge' THEN score END) AS overall,
      MAX(CASE WHEN metric='tests_pass' AND layer='deterministic' THEN score END) AS tests_pass
    FROM evals
    GROUP BY run_id;

    CREATE VIEW IF NOT EXISTS v_model_scorecard AS
    WITH turn_eval AS (
      SELECT
        turn_id,
        MAX(CASE WHEN metric='overall' THEN score END) AS overall,
        MAX(CASE WHEN metric='tests_pass' THEN score END) AS tests_pass
      FROM evals
      WHERE turn_id IS NOT NULL
      GROUP BY turn_id
    ), turn_cost AS (
      SELECT
        turn_id,
        CASE WHEN MIN(COALESCE(cost_known, 0))=1 THEN SUM(cost_usd) ELSE NULL END AS cost_usd,
        MIN(COALESCE(cost_known, 0)) AS cost_known
      FROM sample_events
      WHERE turn_id IS NOT NULL AND kind='model'
      GROUP BY turn_id
    ), attributed_units AS (
      SELECT
        r.agent_type AS agent_type,
        t.run_id AS run_id,
        t.id AS turn_id,
        t.model_id AS model_id,
        COALESCE(t.provider, r.provider) AS provider,
        COALESCE(
          t.composite_score,
          e.overall
        ) AS overall,
        e.tests_pass AS tests_pass,
        c.cost_usd AS cost_usd,
        COALESCE(c.cost_known, 0) AS cost_known
      FROM turns t
      JOIN runs r ON r.id=t.run_id
      LEFT JOIN turn_eval e ON e.turn_id=t.id
      LEFT JOIN turn_cost c ON c.turn_id=t.id
      WHERE t.model_id IS NOT NULL AND t.model_id != ''
    ), legacy_units AS (
      SELECT
        r.agent_type AS agent_type,
        r.id AS run_id,
        NULL AS turn_id,
        COALESCE(r.model_id, 'unknown') AS model_id,
        r.provider AS provider,
        m.overall AS overall,
        m.tests_pass AS tests_pass,
        CASE WHEN r.cost_known=1 THEN r.cost_usd ELSE NULL END AS cost_usd,
        COALESCE(r.cost_known, 0) AS cost_known
      FROM runs r
      LEFT JOIN v_run_metrics m ON m.run_id=r.id
      WHERE NOT EXISTS (
        SELECT 1 FROM turns t
        WHERE t.run_id=r.id AND t.model_id IS NOT NULL AND t.model_id != ''
      )
    ), units AS (
      SELECT * FROM attributed_units
      UNION ALL
      SELECT * FROM legacy_units
    )
    SELECT
      agent_type,
      model_id,
      provider,
      COUNT(DISTINCT run_id) AS runs,
      AVG(overall) AS avg_overall,
      AVG(tests_pass) AS avg_tests_pass,
      CASE WHEN MIN(cost_known)=1 THEN SUM(cost_usd) ELSE NULL END AS total_cost,
      MIN(cost_known) AS cost_known,
      CASE WHEN MIN(cost_known)=1 AND AVG(overall)>0 THEN AVG(CASE WHEN overall IS NOT NULL THEN cost_usd END)/AVG(overall) ELSE NULL END AS cost_per_quality
    FROM units
    GROUP BY agent_type, model_id, provider;

    CREATE VIEW IF NOT EXISTS v_category_scorecard AS
    WITH task_metrics AS (
      SELECT
        task_id,
        MAX(CASE WHEN metric='tests_pass' AND layer='deterministic' THEN score END) AS tests_pass
      FROM evals
      WHERE task_id IS NOT NULL
      GROUP BY task_id
    )
    SELECT
      t.task_category AS task_category,
      COALESCE(t.model_id, r.model_id, 'unknown') AS model_id,
      COALESCE(t.provider, r.provider) AS provider,
      COUNT(DISTINCT t.run_id) AS runs,
      AVG(t.composite_score) AS avg_overall,
      AVG(m.tests_pass) AS avg_tests_pass,
      CASE WHEN MIN(COALESCE(t.cost_known, 0))=1 THEN SUM(t.cost_usd) ELSE NULL END AS total_cost,
      MIN(COALESCE(t.cost_known, 0)) AS cost_known
    FROM tasks t
    JOIN runs r ON r.id=t.run_id
    LEFT JOIN task_metrics m ON m.task_id=t.id
    WHERE t.task_category IS NOT NULL AND t.task_category != 'unknown'
    GROUP BY t.task_category, COALESCE(t.model_id, r.model_id, 'unknown'), COALESCE(t.provider, r.provider);

    -- Sample-granularity scorecard: quality vs cost per (agent, provider, model,
    -- category). A task that used more than one model is stored as 'mixed' rather
    -- than attributed to whichever assistant message happened to arrive last.
    CREATE VIEW IF NOT EXISTS v_sample_scorecard AS
    SELECT
      r.agent_type AS agent_type,
      COALESCE(t.model_id, r.model_id, 'unknown') AS model_id,
      COALESCE(t.provider, r.provider) AS provider,
      t.task_category AS task_category,
      COUNT(*) AS samples,
      AVG(t.composite_score) AS avg_quality,
      CASE WHEN MIN(COALESCE(t.cost_known, 0))=1 THEN SUM(t.cost_usd) ELSE NULL END AS total_cost,
      MIN(COALESCE(t.cost_known, 0)) AS cost_known,
      AVG(t.latency_ms) AS avg_latency_ms,
      CASE WHEN MIN(COALESCE(t.cost_known, 0))=1 AND AVG(t.composite_score)>0
           THEN AVG(t.cost_usd)/AVG(t.composite_score) ELSE NULL END AS cost_per_quality
    FROM tasks t
    JOIN runs r ON r.id=t.run_id
    WHERE t.ended_at IS NOT NULL AND t.composite_score IS NOT NULL
    GROUP BY r.agent_type, COALESCE(t.model_id, r.model_id, 'unknown'), COALESCE(t.provider, r.provider), t.task_category;
    """
}
