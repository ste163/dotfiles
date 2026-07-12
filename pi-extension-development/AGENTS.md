# AGENTS.md — pi-extension-development

This file is auto-discovered by pi only when it is launched with its working
directory inside `pi-extension-development/` (pi walks up from cwd through
parent directories; it does not descend into subdirectories). That means these
rules apply specifically to extension development work, without affecting the
rest of the dotfiles repo.

There is **no build step**. Pi loads extensions via `jiti`, which runs `.ts`
files directly at load time. Nothing here is compiled, bundled, or copied
anywhere — the files you edit in `extensions/` are the exact files pi loads
through the symlinks in `.pi/extensions/`. "Verification" (typecheck, lint,
format, test) is the only thing that happens before code is considered done.

## Hard structural rule

Every extension is a **directory** directly under `extensions/`, containing:

- `index.ts` — the entry point (the only file pi auto-loads per subdirectory)
- at least one colocated `*.spec.ts` file somewhere inside that directory

No bare top-level `.ts` files are allowed directly in `extensions/` (pi
auto-loads every top-level `.ts` file there as its own extension, which would
collide with a colocated spec file sitting next to it at that level).

This is enforced mechanically by `structure.spec.ts` (run as part of `npm
test`), not just documented here — but do not rely on the test alone; follow
the rule when creating new extensions.

## Mandatory checklist — run before any extension work is considered done

All of the following must pass, every time, with no exceptions:

```sh
npm run typecheck   # tsc --noEmit
npm run lint         # oxlint
npm run format       # oxfmt --write
npm test             # node --test, includes the structure.spec.ts hard-rule check
```

- `npm run typecheck` must report zero errors.
- `npm run lint` must report zero errors (categories enabled: `correctness`,
  `suspicious`, `perf` — real bug detection only, not style opinions).
- `npm run format` must be run (or `npm run format:check` in CI) so committed
  code matches oxfmt's output exactly.
- `npm test` must pass at 100%, and **100% test coverage is required** for
  every extension. (Coverage enforcement mechanism is still being finalized —
  see the note in the root `extension-setup.md` plan — but the expectation
  itself is not optional: every function/branch you write needs a test that
  exercises it.)

Do not skip any of these steps. Do not consider a change to an extension
complete until all four commands above have been run and pass cleanly.

## Testing approach — read before writing tests

- **No real disk I/O, no `process.chdir`, no temp directories.** Anything in
  an extension that touches the filesystem (or any other external state) must
  accept its dependencies as injectable parameters (see `PlanModeDeps` in
  `plan-mode/index.ts` for the pattern: a small interface like
  `{ existsSync, cwd }` with a real-implementation default, overridden in
  tests with plain in-memory fakes — e.g. a `Set<string>` standing in for
  "files that exist"). Tests must be fully synchronous-feeling, deterministic,
  and leave nothing behind on disk regardless of pass/fail.
- **No loops with `await` inside unless genuinely sequential.** If iterations
  are independent, use `Promise.all(items.map(...))`. If iterations truly
  depend on the previous one's result (e.g. a retry-until-accepted prompt, or
  handlers that must run in registration order), use recursion instead of a
  `for`/`while` loop with `await` in the body. Do not disable
  `no-await-in-loop` or other lint rules to work around this — refactor the
  code instead.
- Spec files colocate with the code they test (`index.spec.ts` next to
  `index.ts`, `utils.spec.ts` next to `utils.ts`), never in a separate
  parallel test tree.
