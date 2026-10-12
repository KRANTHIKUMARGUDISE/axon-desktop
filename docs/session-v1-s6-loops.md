# Session v1-S6 (Deferred post-v1) — Conditional Edges + Verify Loop

> **Not in v1 (D12).** v1 pipelines are acyclic; ForEach (Session 4) is the only repetition.
> Kept for a later release. Do not run this session as part of v1.

Read first: `CLAUDE.md`, `docs/v1-review.md` (A5, C4, D15), `docs/v1-decisions.md`, `docs/v1-progress.md`.
Start in plan mode.

## Goal
A pipeline can self-correct: implement → test → retry until green, bounded, judged deterministically.
This is the "fewer gates" S3 story.

## Scope
1. **Condition grammar** (deterministic, no eval):
   - `field op value` over the source step's `output.result` and `output.status`.
   - Operators `== != < <= > >= in exists`, joined by `&& ||`.
   - Parsed and validated at save time against the source block's `outputSchema`.
   - Edge selection: the first matching conditional edge, else the default edge.
2. **Loops** as back-edges with
   `loop: {exitWhen, maxIterations (≤10), budget?: {tokens?, minutes?}, onExhausted: failed |
   gate:<nodeId>}`.
3. **Iteration-keyed steps** `(nodeId, iteration)`. Live View shows iterations per node.
   `flatResults` keeps per-iteration history; the latest value wins in the pool.
4. **`previousAttempt` injection:** the prior iteration's result, plus the test-runner failure
   summary, is passed to the looping block when it declares `previousAttempt` in
   contextRequirements.
5. **Cycle-aware validator and resume:**
   - Only edges marked `loop` may create cycles.
   - Resume continues at the correct iteration. Fix the infinite walk in
     `resolvePipelineProgress` and `previewResume`.
6. **`test-runner`** native block (role Decision, seeded):
   - Command comes from block or node config; it is never model-supplied.
   - Runs in the worktree with the S2 env allow-list, a timeout and an output cap.
   - Output `{passed, exitCode, summary, failures[]}`.
   - Cancelling kills the process tree.
7. **Pipeline Creator:** edit conditions and loop settings on an edge; visually distinguish
   back-edges.

## Acceptance criteria
- Loop runs N times and exits when `passed == true`.
- Exhausted → Failed, or routed to the configured gate.
- Budget exceeded → onExhausted.
- Resume mid-loop → correct iteration, no infinite walk.
- An unknown field in a condition is rejected at save.
- `previousAttempt` is visible to the block on iteration 2.
- Cancel during test-runner kills its child processes.
- typecheck, tests, build all pass.

## Out of scope
Parallel branches (DS3), nested loops, review loops, ForEach.
