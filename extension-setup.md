# Pi Extension Development Environment — Plan

## Decisions locked from discussion

- New top-level dir: `pi-extension-development/` (repo root, sibling to `nvim/`, `.pi/`, etc.) — explicitly NOT under `.pi/` so it's clearly not part of pi's own supported config surface.
- Single shared root `package.json` + `tsconfig.json` for ALL custom extensions (no per-extension package.json).
- Test runner: Node's built-in `node --test` (no vitest/jest, minimize deps).
- Lint/format: `oxlint` + `oxfmt` as devDependencies, configured as strict as each tool allows.
- All type-only devDependencies (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `pi-agent-core`) pinned to **exact versions** matching the currently-installed global pi runtime.
- `tsconfig.json`: strictest reasonable settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, etc.).
- **Hard rule going forward: every extension is a directory with `index.ts` as its entry point.** No bare top-level single-file extensions — required so colocated `*.spec.ts` files are always safe (pi only auto-loads `index.ts` per subdirectory; it auto-loads every top-level `.ts` file directly in `extensions/`, which would conflict with a colocated spec file there).
- **Hard rule: every extension directory must also contain at least one colocated `*.spec.ts` file.** No untested extensions allowed to exist.
- Spec files colocate next to the source they test (e.g. `plan-mode/index.spec.ts`, `plan-mode/utils.spec.ts`).
- **No build step, ever.** Pi loads extensions via `jiti`, which runs `.ts` files directly at load time — nothing is compiled/bundled/copied. `.pi/extensions` becomes a symlink straight to `pi-extension-development/extensions/`; the exact same files pi loads are the exact same files being typechecked/linted/tested. "Build" in this project only ever means verification (`tsc --noEmit`, `oxlint`, `oxfmt`, `node --test`) — never an output artifact.
- `node_modules/` under `pi-extension-development/` is gitignored — repo stays shareable, contributor runs `npm install` once after clone.
- Development workflow: `cd pi-extension-development/` before doing any extension work (building/testing/linting all run from inside this dir). This also means an `AGENTS.md` placed at `pi-extension-development/AGENTS.md` is auto-discovered by pi (cwd + parent-walk discovery) whenever pi is launched from inside that directory or a subdirectory of it — scoping its instructions to extension development without bleeding into the rest of the dotfiles repo.
- `AGENTS.md` in `pi-extension-development/` must mandate (not just mention) — as a hard checklist the agent must run before considering any extension work complete:
  - `npm run typecheck` (tsc --noEmit)
  - `npm run lint` (oxlint)
  - `npm run format` / `npm run format:check` (oxfmt)
  - `npm test` (node --test)
  - 100% test coverage requirement (enforcement mechanism TBD — see open item below)
  - The directory+`index.ts`+colocated-`*.spec.ts` structural rule, restated for the agent's awareness (in addition to the automated structure test enforcing it).

## Open items deferred (explicitly, not blocking this plan)

- **Coverage enforcement mechanism**: whether Node's native `--experimental-test-coverage` (+ threshold flags, if this Node version supports them) is sufficient, or whether a `c8` devDependency wrapper is needed instead. Deferred — "we will check this later" per your instruction. Plan proceeds without hard-wiring a specific mechanism yet; `npm test` will run coverage in whatever form is easiest to wire first, revisited once verified.
- **Duplicate-module risk**: local `node_modules/@earendil-works/pi-coding-agent` (devDependency, for types) vs. pi's own live in-memory copy used when jiti loads the symlinked extension. Versions will be pinned to match; needs an empirical check (`/reload` after wiring the symlink) before trusting it. Fallback if it causes trouble: vendored `.d.ts` stub instead of a real installed package.
- **`.pi/npm/`**: currently appears tracked in the dotfiles repo as pi's own package-manager cache. Separate decision, unrelated to this plan, parked for later.

## Plan:

1. Create `pi-extension-development/` at repo root with `extensions/` subdirectory inside it.
2. Move `.pi/extensions/plan-mode/` (`index.ts`, `utils.ts`) into `pi-extension-development/extensions/plan-mode/`, preserving contents as-is (no rule changes yet, just relocation).
3. Delete the now-empty `.pi/extensions/` directory (fully replaced by the symlink in step 9).
4. Add `pi-extension-development/package.json`: no runtime `dependencies` (extensions get their pi-provided imports resolved by jiti at load time, not from local `node_modules`), `devDependencies` pinned to exact versions for `typescript`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `oxlint`, `oxfmt`. Scripts: `test` (`node --test` against `extensions/**/*.spec.ts`, coverage flag(s) TBD per open item), `typecheck` (`tsc --noEmit`), `lint` (`oxlint`), `format` (`oxfmt --write`), `format:check` (`oxfmt --check`).
5. Add `pi-extension-development/tsconfig.json`: strictest settings, ESM/bundler module resolution appropriate for jiti's runtime behavior, `include` pointed at `extensions/**/*.ts`.
6. Add `pi-extension-development/.gitignore` (or extend root `.gitignore`) to exclude `node_modules/` (and any coverage output dir once the coverage mechanism is chosen).
7. Add oxlint config (`.oxlintrc.json`) with all correctness/suspicious/pedantic rule categories enabled; oxfmt likely needs no config (opinionated defaults) — confirm during implementation.
8. Write `pi-extension-development/extensions/structure.spec.ts` (or similar top-level meta-test): walks every entry directly under `extensions/`, and for each one asserts:
   - it is a directory (fails if a bare top-level `.ts` file is found instead)
   - it contains an `index.ts`
   - it contains at least one `*.spec.ts` file colocated somewhere inside it
   This is the automated enforcement of the hard structural rule, run as part of `npm test`.
9. Update `install.sh`: change the `.pi/extensions` entry so it symlinks `pi-extension-development/extensions` as the target instead of a real `.pi/extensions` directory (verify `link_entry`'s dir-symlink handling still applies correctly to this new target).
10. Run `npm install` inside `pi-extension-development/`, then empirically verify the extension still loads correctly through the new symlink path (`/reload` in pi, confirm `plan-mode` commands still work) — specifically checking for the duplicate-module risk noted above.
11. Write colocated `plan-mode/index.spec.ts` and `plan-mode/utils.spec.ts` as real tests (satisfying both the structure rule from step 8 and giving actual coverage of the existing extension).
12. Write `pi-extension-development/AGENTS.md` per the mandatory-checklist decisions above (typecheck/lint/format/test commands, 100% coverage requirement, structural rule restated for the agent).
13. Write `pi-extension-development/README.md` (human-facing, complements `AGENTS.md`) documenting: the hard directory+`index.ts`+spec-file rule, how to add a new extension, the explicit "no build step — jiti runs `.ts` directly, symlink is the only mechanism" clarification, how to run `npm test`/`lint`/`format`/`typecheck`, and the "`cd pi-extension-development/` before doing extension work" instruction.

## Next step

Once you approve this plan, exit plan mode and I'll execute steps 1–13 in order.
