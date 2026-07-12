# Pi Extension Development Environment — Plan

## Status: implemented and verified. This doc now tracks what's done vs. what's left

## Decisions locked from discussion (all implemented)

- New top-level dir: `pi-extension-development/` (repo root, sibling to `nvim/`, `.pi/`, etc.) — explicitly NOT under `.pi/` so it's clearly not part of pi's own supported config surface. **Done.**
- Single shared root `package.json` + `tsconfig.json` for ALL custom extensions (no per-extension package.json). **Done.**
- Test runner: Node's built-in `node --test` (no vitest/jest, minimize deps). **Done.**
- Lint/format: `oxlint` + `oxfmt` as devDependencies. **Done**, with a correction mid-implementation — see "Lessons learned" below.
- All type-only devDependencies (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `pi-agent-core`) pinned to **exact versions** (`0.80.6`, matching the installed global pi runtime). **Done.**
- `tsconfig.json`: strict settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals/Parameters`, etc.), plus `allowImportingTsExtensions` (required since jiti/`--experimental-strip-types` need explicit `.ts` extensions in imports). **Done.**
- **Hard rule: every extension is a directory with `index.ts` as its entry point.** No bare top-level single-file extensions. **Done**, mechanically enforced by `structure.spec.ts`.
- **Hard rule: every extension directory must contain at least one colocated `*.spec.ts` file.** **Done**, enforced by the same `structure.spec.ts`.
- Spec files colocate next to the source they test. **Done** (`plan-mode/index.spec.ts`, `plan-mode/utils.spec.ts`).
- **No build step, ever.** Jiti runs `.ts` directly; `.pi/extensions/<name>` symlinks point straight at `pi-extension-development/extensions/<name>`. **Done**, and documented in both READMEs + `AGENTS.md`.
- `node_modules/` under `pi-extension-development/` gitignored. **Done.**
- Development workflow: `cd pi-extension-development/` before extension work; `AGENTS.md` there is auto-discovered by pi when launched from inside that dir (cwd + parent-walk discovery, no subdirectory descent). **Done**, documented.
- `AGENTS.md` mandates (not just mentions) the full checklist: `npm run typecheck`, `npm run lint`, `npm run format`, `npm test` (which now includes 100%-coverage enforcement — see below), plus the structural rule restated. **Done.**

## Symlink architecture (final, resolved after discussion)

`.pi/extensions/` stays a **real, tracked directory** — NOT itself a symlink — because package-managed state (`pi-permission-system/config.json`, tracked; `logs/`, gitignored) also lives there and must keep working. `install.sh` loops over every directory in `pi-extension-development/extensions/` and creates/repairs one symlink per extension inside `.pi/extensions/` (e.g. `.pi/extensions/plan-mode -> pi-extension-development/extensions/plan-mode`). The pre-existing whole-dir symlink (`.pi/extensions -> ~/.pi/agent/extensions`) then carries everything through automatically. **Implemented, run, and verified** — `install.sh` output confirmed 11/11 symlinks OK, including the new `plan-mode` one.

New extensions require rerunning `install.sh` once (documented in root `README.md` and `pi-extension-development/README.md`); editing existing extension source is live immediately.

## Open items — RESOLVED during implementation

- **Coverage enforcement mechanism**: RESOLVED. Node 24.16's native `--experimental-test-coverage` + `--test-coverage-lines/branches/functions=100` flags work correctly — verified they actually fail the run (exit code 1) when coverage is below threshold. No `c8` dependency needed. Wired into `npm test` in `package.json`, using a single recursive glob (`"**/*.spec.ts"`) instead of listing files explicitly, with `--test-coverage-exclude="node_modules/**"` as a defensive guard.
- **Duplicate-module risk** (local devDependency copy of `@earendil-works/pi-coding-agent` vs. pi's own live in-memory copy when jiti loads the symlinked extension): NOT YET EMPIRICALLY VERIFIED. `install.sh` was run and symlinks are correct, but nobody has actually done a live `/reload` inside a running pi session pointed at the new symlinked `plan-mode` to confirm there's no duplicate-module conflict at runtime. **Still open — see "Left for a future session" below.**
- **`.pi/npm/`**: RESOLVED, no action needed. Already gitignored (`.gitignore:8:.pi/npm/`) and confirmed untracked via `git ls-files`. Not a further concern.

## Lessons learned during implementation (worth remembering)

- Initial `.oxlintrc.json` blindly enabled every oxlint category (`pedantic`, `restriction`, `nursery`, `style`) trying to be "as strict as possible." This was wrong — those categories are full of style-dogma rules (`no-ternary`, `no-async-await`, `id-length`, `no-magic-numbers`, `sort-keys`, `require-await`, etc.) that fight completely standard, correct TypeScript. Corrected to only `correctness`, `suspicious`, `perf` — real bug detection, not opinion enforcement.
- `no-await-in-loop` (a legitimate rule, kept enabled) flagged three genuinely-sequential-or-independent loops. Fixed by refactoring instead of disabling:
  - `promptForPlanFileName` (retry-until-unique-name prompt) → converted to recursion (genuinely sequential, each attempt depends on the previous answer).
  - `index.spec.ts`'s `callHandler` test helper (handlers must run in registration order, matching pi's real dispatch semantics) → converted to recursion.
  - `structure.spec.ts`'s per-extension structure checks (genuinely independent) → converted to `Promise.all(...)`.
  - Rule stayed enabled the whole time; this is the pattern to repeat for any future occurrences rather than reaching for a rule disable.
- `plan-mode/index.ts` was refactored for testability per explicit instruction: pulled real `existsSync`/`process.cwd()` calls behind an injectable `PlanModeDeps` interface (`{ existsSync, cwd }`), defaulted to the real implementations, overridable in tests with plain in-memory fakes (a `Set<string>`-backed fake, no real disk I/O, no `process.chdir`, no temp directories). This is the required pattern for any future extension that touches the filesystem or other external state.

## Left for a future session

1. **`plan-mode` is not at 100% test coverage yet**, and `npm test` currently fails on the coverage threshold (confirmed: exit code 1, ~81% lines / ~83% branches / ~84% functions overall). Explicitly deferred as separate work, not part of this setup task. Needs tests added for the currently-uncovered parts of `index.ts`: `turn_end` progress tracking, `agent_end`'s execute-plan/refine-plan/plan-complete flows, `session_start`'s resume/branch-rebuild scanning logic, and a few smaller uncovered branches. `structure.spec.ts` itself also has a couple of uncovered lines/branches worth a look.
2. **Empirically verify the duplicate-module risk** noted above: start a real pi session, confirm `plan-mode` loads and behaves correctly through the new `.pi/extensions/plan-mode` symlink (not just that the symlink exists), and specifically watch for any sign that pi's own live `@earendil-works/pi-coding-agent` instance and the local devDependency copy in `pi-extension-development/node_modules` are conflicting (e.g. `isToolCallEventType` behaving unexpectedly). If problems appear, the documented fallback is a vendored `.d.ts` stub instead of a real installed package.
3. No other open items — symlink architecture, structural hard rules, lint/format/typecheck config, and the coverage mechanism itself are all implemented and considered final.
