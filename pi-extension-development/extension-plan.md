# Plan: file-path-rules Extension

## Purpose

Build the `file-path-rules` extension in the pi-extension-development repo,
and land the review fixes for it. The extension reads rules from each
project's `.pi/rules/*.md` files. Each rule maps glob patterns to a doc.
When the model touches a matching path with read, edit, or write, the
extension appends the doc as a reminder into the tool result content. The
model sees the rule right after the touch.

The plan also covers two supporting changes:

- Harden plan-mode plan parsing. An unparseable plan must never block
  execution again.
- Add trust gating to the hooks extension.

## Out of scope

The runner repo config migration. That work moves
`.github/instructions/*.instructions.md` to `.pi/rules/*.md`, changes
`applyTo` to `paths`, deletes the old directory, and updates AGENTS.md. It
is config-only work in another repo and stays separate.

## Resolved decisions

- Extension name: `file-path-rules`.
- Config format: one rule per file in `.pi/rules/*.md`. A `paths:`
  front-matter field holds a string or a list of strings. The doc body
  (front matter stripped) is the reminder content.
- Glob engine: hand-rolled, no runtime dependencies. Vocabulary: double
  star as a whole segment (zero or more directories), star (no slash),
  question mark (one char), and brace alternation `{a,b}`. Dot directories
  work because segments match literally. A pattern that is exactly `**` or
  `**/` matches everything, a bare file included. Multi-segment globstar
  patterns keep their segment behavior, so `**/**` does not match a bare
  file - accepted boundary.
- Firing: read, edit, and write tools only. The pattern match uses the
  project-relative form of `event.input.path`.
- Dedupe: once per file per session. The key is the fully normalized
  absolute path (the tool input resolved against `ctx.cwd`), so every
  spelling of one file (`./a.ts`, `a//b.ts`, `a/../b.ts`, the absolute
  form) fires once.
- Mark and append split: `tool_call` marks the path fired and stores the
  project-relative matched path plus the matched rules per `toolCallId`
  (preflight is sequential, so parallel calls on one file cannot
  double-fire). `tool_result` appends the reminders from the stored entry.
  A call that is blocked later consumes its reminder without appending it.
  This trade is accepted: exactly-once wins.
- Reminder block format: one text block per matched rule. Header line:
  `[file-path-rules] rule: .pi/rules/<name> — matched: <path>`. Then the
  doc body.
- Trust: rule loading runs only for trusted projects
  (`ctx.isProjectTrusted()`). The same gate goes into hooks.
- Plan parsing: accept markdown header forms (`## Plan`, `**Plan:**`,
  `Plan`) and markdown inside steps. When the last assistant message has
  no parseable plan, plan-mode sends one corrective follow-up turn that
  states the required format. A session flag limits corrections to one per
  failure streak. The Execute option appears only when a plan parsed.

## Test rules

- No real disk I/O, no `process.chdir`, no temp directories. Injectable
  deps (the PlanModeDeps pattern).
- No loops with `await` inside. Use recursion or Promise.all.
- Spec files colocate with the code they test.
- 100% line, branch, and function coverage.
- Black-box tests: fake pi and fake ctx, in-memory fakes.

## Implemented

The PR delivered the base extension (`match.ts`, `config.ts`, `deps.ts`,
`index.ts` with colocated specs), the plan-mode parsing hardening
(`utils.ts`, `messages.ts`, `index.ts`), and the hooks trust gating with
specs. The remaining work below is the review-fix iteration.

## Remaining work

1. Fix `globToRegExp` in `extensions/file-path-rules/match.ts`. A
   standalone `**` or `**/` pattern compiles to `^.*$` and matches a bare
   file. Multi-segment globstar behavior stays unchanged. While editing,
   remove the `let previousGlobstar` flag - the slash-skip rule derives
   from `index === 1 && segments[0] === "**"`. Add match.spec.ts cases for
   bare `**`, bare `**/`, and a file at depth against `**`.
2. Store the matched path in the pending entry at `tool_call` time in
   `extensions/file-path-rules/index.ts`. The entry holds the
   project-relative display path plus the matched rules. `tool_result`
   reads the path from the entry instead of `event.input.path`. Delete the
   empty-string fallback and the duplicate normalization. Update
   index.spec.ts: replace the empty-match test with one that asserts the
   stored path appears when the result input has none.
3. Change the dedupe key in `extensions/file-path-rules/index.ts` to a
   fully normalized absolute path. Resolve the tool input against
   `ctx.cwd` for the fired check and key; keep the relative form for
   pattern matching. Update index.spec.ts with dedupe tests for `./`,
   duplicate-separator, `..`, and absolute spellings of one file.
4. Rewrite `findMatchingBrace` in `extensions/file-path-rules/match.ts`
   with recursion. Remove the `let` counters and the for loop.
5. Refactor `session_start` in `extensions/plan-mode/index.ts` to remove
   `let persisted`. Use else-paths: each branch that persists calls
   `persistState()` itself, and the fallback runs only when no branch did.
   Keep the same persistence behavior, including persisting a naming
   cancellation on resume.
6. Add one trust-gating line to `extensions/hooks/README.md`: hooks run
   only for trusted projects, and trust granted mid-session activates
   hooks on the next event.

## Verification

- The repo hook runs typecheck, lint, format:check (auto-formatting on
  failure), and tests on settle. Fix every failure until the hook reports
  a pass. All touched files keep 100% coverage.
- Live-verify in a scratch project: create
  `~/.pi/agent/extensions/file-path-rules` pointing at the new directory,
  add a `paths: "**"` rule as the regression case for fix 1, touch a bare
  file and a nested file, and confirm the reminder appears once per file.
