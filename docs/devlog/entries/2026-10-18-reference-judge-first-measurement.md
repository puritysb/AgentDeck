# 2026-10-18 — Reference judge: the local judge passes or fails, and 60% of its fails are one misread batch

Workshop decision ⑪ (2026-10-16) asked for a reference judge driven through
`codex exec` and an agreement metric against the local judge. Both now exist
as `agentdeck apme reference-judge` and `agentdeck apme agreement`
([bridge/src/apme/reference-judge.ts](bridge/src/apme/reference-judge.ts)). This
entry records the first measurement, the isolation check, and the design
choices that the diff alone does not explain.

**Setup.** Local judge `mlx:gemma-4-26b-a4b-it-4bit`, reference
`codex:gpt-6-astra@high` on the owner's Codex login. The pool was the 996
locally judged tasks closed in the last 30 days. The reference saw exactly the
prompt the local judge saw (`buildTaskJudgeInput`, extracted from
`runTaskEval`), with credentials redacted.

**Uniform sample, n=12.** MAE 0.24 (95% bootstrap CI 0.10–0.43). Bias +0.08
(CI −0.14 to +0.28). 9 of 12 tasks landed in the same outcome band. Cohen's
kappa was −0.09 and Spearman −0.31. Every local score was exactly 0 or 1;
the reference gave such a score once.

**The local judge is binary.** Of the 996 local verdicts in the window, 70.6%
are exactly 1.00 and 19.7% exactly 0.00. Over gemma's whole history it is
1,311 and 289 out of 1,805. The previous local judge, Qwen3.6-35B, gave 1.0
in 218 of 773 verdicts. So the kappa and Spearman above are artefacts of ties,
not measurements: a judge with two values leaves rank correlation nothing to
rank.

**The fail band is mostly one batch.** The window holds 216 local fails
(score < 0.5). Of these, 130 come from the 2026-10-01 headless `codex exec`
image batch, where the local judge failed 130 of 140 tasks. Its reasoning
repeats almost word for word: the agent "replied DONE without actually
executing the image generation … the tool calls show the agent attempted to
copy a file". The recorded trajectory shows the agent read the imagegen
skill, called the image tool, copied the generated file from
`~/.codex/generated_images/` to the requested path, and replied `DONE`. The
work was done, and the evidence was in the prompt the local judge read.

A `local_band=fail` sample (n=8) plus the one fail from the uniform sample put
7 image tasks in front of the reference. It overturned all 7, scoring them
0.92–0.96. It confirmed the 2 non-image fails: an opencode task that refused
to replace a live ad creative (0.22), and a task whose only prompt was a
`<task-notification>` (0.40). So the precision of local fails in that slice
was 2 of 8. With 0 confirmations in 7 image tasks, the 95% upper bound on the
batch's true fail rate is about 35%. At least ~85 of the 216 fails are
therefore false, and most likely nearly all 130.

**Not user work, still judged.** In the same window, 75 judged tasks consist
only of a `<task-notification>`. Another 98 are Codex Desktop background
threads: 34 ambient-suggestion threads (09-21 to 09-29) and 64 composer
suggestions (10-10 to 10-17). The ingestion-time drop rules do not purge rows
recorded before them. One uniform pick was a composer suggestion, scored 1.00
locally and 0.30 by the reference.

**Isolation, measured rather than assumed.** During the 12-call run, Codex
wrote no new rollout (3 before, 3 after), and no APME run or turn started in
the run's window. This rests on `--ephemeral` (no rollout) and
`--ignore-user-config`. The user config holds AgentDeck's own Codex hooks;
loading it would have reported each judge call to the daemon as a Codex
session and opened an APME run, as in the 2026-10-01 flood.

**No tools, and `--json` does not show every tool call.** `-s read-only`
blocks writes, not reads. Synthetic prompts asked the model to check a claim
itself if it could: a line in `/etc/hosts`, and for the web row a Rust
release number (codex-cli 0.160.1, no user data):

| Configuration | What the model did | Input tokens |
|---|---|---|
| Isolation flags only | ran `rg` over `/etc/hosts`, scored 1 | 31.5k |
| Other tools off, web search left at its default | 2 web searches | 46.4k |
| `shell_tool` + `unified_exec` off | 2 calls to code mode's `exec`, absent from the event stream | 64.0k |
| 16 tool features off, `web_search=disabled` | no tool call, said it could not verify | 10.0k |

The code-mode calls showed up only as `ToolCall: exec` lines under
`RUST_LOG=codex_core=info`. So checking isolation by reading the event
stream is not enough: what `--json` cannot show has to be prevented. With
`code_mode_host` off, code mode fails closed. The judge now runs with all 16
features off and web search disabled. A run whose events still show a tool
item, or warn that Codex ignored a setting, is discarded. An unknown `-c`
key is only a warning, so a renamed `web_search` would otherwise leave the
web on.

The 20 verdicts above were made with tools available. None used them. I
rebuilt all 20 prompts (`prompt_sha` matched 20/20) and regressed input tokens
on prompt size. Every residual lies between −566 and +1,018 tokens. A tool
call needs a second request that re-sends the ~15.7k fixed part, and the
search probe added 36k.

**Cost.** Median 12 s per call. Input tokens are Codex's fixed part plus the
prompt. The fixed part was 15.7k with tools on and is 9.7–10.2k with them
off. The prompt costs about 0.91 tokens per Hangul syllable and 0.28 per other
character. The 12-task run took 143 s. Four more uniform verdicts after the
hardening bring that sample to n=16: MAE 0.23 (CI 0.12–0.36), bias +0.11.

**Design choices and rejected alternatives.**

- **Storage.** Reference verdicts go in `reference_evals`, not `evals` under a
  new layer. Every scorecard, outcome and Work-board query reads `evals`, and
  a query that forgets to filter on layer would put the reference's opinion
  into the product.
- **Sampling.** The sample is uniform, ordered by a hash of (seed, task id),
  rather than newest-first or stratified by category. Uniform is the only
  design whose agreement estimates the pool's. The hash keeps a task in place
  however the pool grows, so a rerun continues with the next tasks instead of
  reshuffling. That alone did not make the dry run's list the run's: tasks
  closed or judged in between changed the pool, so the dry run now prints the
  `--run` command pinned to its time (`--until`) and its list's digest
  (`--expect`).
- **Sampling design is stored and reported apart.** The first draft pooled all
  of a judge's rows. Once the fail-band run landed, the pooled MAE (0.46) was
  neither the population figure (0.24) nor the fail-band precision (25%). Each
  row now carries `sample`, and the report is per (judge, design). A rerun
  skips only tasks scored in the same design. Positions 20 and 21 of the
  uniform order are fail-band tasks, and skipping them would have under-counted
  fails in the uniform sample.
- **Effort.** The default is `high`, not the owner's Codex default `ultra`,
  which delegates to subagents; one verdict has no use for delegation.
- **No daemon or Swift path.** Every call sends task text to a hosted model,
  so it runs only when the user types the command. The App Store app spawns
  no subprocess.

**Follow-ups.** None of these are in this change.

1. Have task-gradeability decline `<task-notification>`-only tasks, and retract
   the historical Codex background-thread verdicts. This is a cross-daemon
   rule: Node SSOT plus a generated Swift mirror.
2. Make the image-batch misread the first target of the OPRO loop: revise the
   rubric from these disagreements, then re-score the same sample.
3. Add a task-level human label path to calibrate the reference.
   `vibe_feedback` labels a run, not a task.
