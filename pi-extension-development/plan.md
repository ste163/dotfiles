# Plan: coding-standards skill for pi-extension-development (wiring only)

Dir: `pi-extension-development/.agents/skills/coding-standards/SKILL.md`
(dot required — matches pi's project skill discovery: `.agents/skills/`
searched from cwd up through ancestor dirs to git repo root; scopes to
extension-dev work same as AGENTS.md already does, avoids collision with
repo-root `.pi/skills/caveman`).

One skill, not two — small enough to always load, covers both TS style and
testing conventions.

**No invented standards.** This step is scaffolding only: valid frontmatter +
empty section headers as placeholders. User supplies actual content next.

1. Create `pi-extension-development/.agents/skills/coding-standards/SKILL.md`
   with:
   - Frontmatter: `name: coding-standards`, a generic always-relevant
     `description` (e.g. "TypeScript coding standards and testing
     conventions for this project. Always load when writing or editing code
     or tests in pi-extension-development.") — placeholder wording, user may
     want to refine.
   - Empty placeholder sections only, no content invented:
     - `## TypeScript Style` (empty)
     - `## Testing` (empty)
   - No references to AGENTS.md/README content — user said not to assume
     what standards are "real"; they'll dictate everything.

2. Verify discovery: confirm pi lists `coding-standards` in system prompt
   when launched with cwd inside `pi-extension-development/`, and
   `/skill:coding-standards` loads it.

3. Stop here. Wait for user to dictate actual standards content before
   filling in the two sections.
