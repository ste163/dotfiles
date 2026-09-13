# Plan: extension-plan.md review fixes

Fix the findings from the extension-plan.md implementation review:
one glob-matcher bug, two pending/dedupe deviations, two coding-standards
violations, one README gap, and final verification.

Plan:

1. Fix `globToRegExp` in extensions/file-path-rules/match.ts so a
   standalone `**` or `**/` pattern compiles to `^.*$` and matches a bare
   file path. Keep the existing leading/trailing/middle globstar behavior
   for multi-segment patterns unchanged. Add spec cases to match.spec.ts
   for bare `**`, bare `**/`, and a file at depth against `**`.
2. Store the normalized path in the pending entry at `tool_call` time in
   extensions/file-path-rules/index.ts. Change the pending record to hold
   the path plus the matched rules. Read the path from the entry in
   `tool_result` instead of `event.input.path`. Delete the empty-string
   fallback and the duplicate normalization. Update index.spec.ts for the
   removed fallback.
3. Change the dedupe key in extensions/file-path-rules/index.ts to a
   fully normalized absolute path. Resolve the tool input path against
   `ctx.cwd` for the fired check and key, keep the relative form for
   pattern matching. Update index.spec.ts with dedupe tests for `./` and
   duplicate-separator spellings of one file.
4. Rewrite `findMatchingBrace` in extensions/file-path-rules/match.ts
   with recursion. Remove the `let` counters and the for loop.
5. Refactor `session_start` in extensions/plan-mode/index.ts to remove
   `let persisted`. Call `persistState()` inside each branch that sets
   the flag today and once in the fallback condition. Keep the same
   persistence behavior, including persisting a cancellation on resume.
6. Add one trust-gating line to extensions/hooks/README.md: hooks run
   only for trusted projects, and trust granted mid-session activates
   hooks on the next event.
7. Let the repo hook verify typecheck, lint, format, and tests. Fix every
   failure until the hook passes. Then live-verify in a scratch project
   with a `paths: "**"` rule as the regression case for step 1.
