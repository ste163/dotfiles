# Plan: file-path-rules Extension

## Purpose

Build the `file-path-rules` extension in the pi-extension-development repo.
The extension reads rules from each project's `.pi/rules/*.md` files. Each
rule maps glob patterns to a doc. When the model touches a matching path
with read, edit, or write, the extension appends the doc as a reminder into
the tool result content. The model sees the rule right after the touch.

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
  work because segments match literally.
- Firing: read, edit, and write tools only. The match uses
  `event.input.path`. The reminder fires once per file per session. Dedupe
  uses the normalized absolute path.
- Mark and append split: mark fired on `tool_call` (preflight is
  sequential), append on `tool_result` keyed by `toolCallId`. A call that
  is blocked later consumes its reminder without appending it. This trade
  is accepted: exactly-once wins.
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

## Plan:

1. Harden plan-mode plan parsing and validation.
   - utils.ts: replace the header regex with a lenient per-line pattern.
     It accepts `Plan:`, `Plan`, and markdown heading or bold forms.
     Capture full numbered step lines and strip markdown inside
     `cleanStepText`. Add `planFormatIssue(message)`. It returns the exact
     problem (missing header, no numbered steps, steps filtered out) or
     null when a plan parses.
   - index.ts: at `agent_end`, when extraction finds nothing, send one
     corrective follow-up turn (`formatCorrectionMessage` with the issue)
     and skip the next-action prompt. A `formatWarned` state flag, cleared
     when a valid plan extracts, limits this to one corrective turn per
     failure streak. A repeat failure only notifies and shows the prompt.
     Offer the Execute plan option only when todos exist.
   - messages.ts: add `formatCorrectionMessage(issue)`.
   - Update utils.spec.ts and index.spec.ts. Update README.md with the
     required plan format.

2. Create `extensions/file-path-rules/` with deps.ts, match.ts,
   config.ts, index.ts, README.md, and colocated specs.

3. Write the glob matcher (match.ts). `relativePath` strips `./` and the
   cwd prefix. `globToRegExp` converts one pattern to an anchored regex:
   split on `/`; a whole double-star segment becomes zero-or-more
   directories; star and question mark become non-slash chars; `{a,b}`
   becomes alternation; other chars are escaped. `matchesAny(path,
patterns)` tests all patterns.

4. Write rule loading (config.ts). `loadRules(deps, cwd)` lists
   `<cwd>/.pi/rules/*.md` via `CONFIG_DIR_NAME`, sorted for determinism.
   Parse each file with `parseFrontmatter` from
   `@earendil-works/pi-coding-agent`. Skip files without `paths:` silently.
   Validate `paths` as a string or a non-empty list of non-empty strings.
   Return `{ rules, errors }`. Each error names the file and the problem.
   Rule shape: `{ file, patterns, body }`.

5. Wire index.ts. deps.ts exposes `readFile` and `readdir` (null on
   missing or unreadable). `session_start` loads rules when
   `ctx.isProjectTrusted()` is true. An untrusted project loads nothing
   and the extension stays inert. Reason `reload` re-loads rules and
   clears fired/pending state. Config errors are notified once.

6. Tool events. `tool_call`: for read, edit, and write, normalize
   `input.path` to an absolute path. Find all rules whose patterns match.
   When any match and the path is not yet fired: mark fired and store the
   matched rules in `pending[toolCallId]`. `tool_result`: when
   `pending[toolCallId]` exists, append one text block per rule and clear
   the pending entry. Non-path tools and untrusted projects do nothing.

7. Write tests. match.spec.ts covers every glob form, braces, dot
   directories, no cross-segment star, and relative path normalization.
   config.spec.ts covers a missing dir, files without `paths`, string and
   list paths, invalid YAML, invalid paths values, body stripping, and
   sort order. index.spec.ts covers fire-once-per-file, multiple rules on
   one path, parallel same-file calls, non-path tools, untrusted project
   inertness, reload reset, and error notification. Failure cases first,
   success after.

8. Add trust gating to hooks. In `session_start`, `tool_call`, and
   `agent_settled`, return early when `!ctx.isProjectTrusted()` before
   `ensureConfig` and before running hooks. Per-event checks mean trust
   granted mid-session activates hooks on the next event. Update
   index.spec.ts with the new fake ctx method and untrusted-then-trusted
   tests.

9. Verify. The repo hook runs typecheck, lint, format:check
   (auto-formatting on failure), and tests on settle. Fix every failure
   until the hook reports a pass. All touched files need 100% coverage.

10. Symlink and live-verify. Create `~/.pi/agent/extensions/file-path-rules`
    pointing at the new directory. In a scratch project with sample
    `.pi/rules/*.md` files, touch a matching path and confirm the reminder
    appears in the tool result, once per file.
