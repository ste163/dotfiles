# pi-extension-development

Standalone TypeScript project for developing custom pi extensions used by this
dotfiles repo. This directory is **not** part of pi's own supported config
surface (`.pi/`) on purpose — it's a normal, independently-tooled TS project
that happens to produce files pi loads via a symlink bridge. See the root
[README.md](../README.md#extensions) for how that bridge works.

## There is no build step

Pi loads extensions via [`jiti`](https://github.com/unjs/jiti), which runs
`.ts` files directly at load time — nothing here is ever compiled, bundled, or
copied. The files in `extensions/` are the exact same files pi loads through
the symlinks in `.pi/extensions/`. "Building" in this project only ever means
_verification_: typecheck, lint, format, test. If you're looking for a
`dist/` or similar output directory, it doesn't exist and never will.

## Workflow

```sh
cd pi-extension-development/
npm install          # first time only, or after devDependency changes
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint (correctness/suspicious/perf only)
npm run format       # oxfmt --write
npm test             # node --test
```

All four commands must pass cleanly before considering any extension change
done — see [AGENTS.md](AGENTS.md) for the full mandatory checklist an agent
must follow, and for the testing-approach rules (dependency injection instead
of real disk I/O, recursion/`Promise.all` instead of disabling lint rules).

## Adding a new extension

1. Create a directory under `extensions/<name>/` with an `index.ts` entry
   point (this is the hard structural rule — see below).
2. Add at least one colocated `*.spec.ts` file inside that directory
   (`index.spec.ts`, `utils.spec.ts`, whatever matches the files you're
   testing).
3. Run the full checklist above.
4. From the repo root, rerun `install.sh` once so it creates the matching
   symlink at `.pi/extensions/<name>` (`install.sh` loops over
   `pi-extension-development/extensions/*` and links each one individually —
   see the comment in `install.sh` for why `.pi/extensions/` itself stays a
   real, tracked directory rather than a symlink). After that one-time step,
   editing the extension's source is live immediately, same as everything
   else this repo symlinks.

## Hard structural rule

Every extension is a **directory** directly under `extensions/`, containing:

- `index.ts` — entry point (the only file pi auto-loads per subdirectory)
- at least one colocated `*.spec.ts` file somewhere inside the directory

No bare top-level `.ts` files directly in `extensions/` — pi auto-loads every
top-level `.ts` file there as its own extension, which would collide with a
colocated spec file sitting next to it at that level.

This is enforced mechanically by `structure.spec.ts` (part of `npm test`), not
just documented — but don't rely on the test alone; follow the rule up front
when scaffolding a new extension.

## Testing approach

- No real disk I/O, no `process.chdir`, no temp directories in tests. Anything
  filesystem-dependent is written with injectable dependencies (see
  `PlanModeDeps` in `plan-mode/index.ts` for the pattern) so tests can pass
  plain in-memory fakes instead.
- No loops with `await` inside unless the iterations are genuinely sequential
  (each depends on the previous one's result). Independent iterations use
  `Promise.all`; genuinely sequential ones use recursion instead of a
  `for`/`while` loop. Lint rules that catch this (`no-await-in-loop`) are
  fixed by refactoring, never disabled.
- Spec files always colocate with the code they test.

## Tooling versions

`devDependencies` are pinned to **exact versions** (no `^`/`~` ranges),
matching whatever `@earendil-works/pi-*` version is currently installed
globally, so the types used here match the runtime pi actually loads
extensions with.
