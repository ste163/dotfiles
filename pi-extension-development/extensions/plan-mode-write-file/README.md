# plan-mode-write-file

A pi extension for read-only exploration with one writable plan file. While
it is on, bash is restricted to a read-only allowlist and the write/edit
tools work only on the single user-named plan file. Everything else is
blocked.

The name is deliberate: this extension is not a generic plan mode. Its one
writable file is the plan file, so the extension is named for that behavior.

## Commands

| Command                  | What it does                                       |
| ------------------------ | -------------------------------------------------- |
| `/plan-write-file`       | Toggle the mode on and off.                        |
| `/plan-write-file-todos` | Show the current plan todo list with done markers. |
| `/plan-write-file-name`  | Show the currently locked plan file name.          |

The shortcut `Ctrl+Alt+P` toggles the mode. The `--plan-write-file` flag
starts a session with the mode already on.

## Workflow

1. Run `/plan-write-file`. Name the plan file, or accept the default
   `plan.md`. The file lives in the session cwd.
2. The agent makes a numbered plan under a `Plan:` header and writes it to
   that file. No other writes or edits are allowed.
3. At the end of the turn, choose `Execute the plan (track progress)`. Full
   access comes back and a progress widget tracks the steps.
4. The agent marks each finished step with a `[DONE:n]` tag.

## Plan file rules

- The name is asked once per toggle-on. It is reused while the file still
  exists on disk. A name collision with an existing file forces a new
  prompt.
- Only the basename is kept. Directory parts are stripped, so the file
  always lives in the cwd.
- The state persists across sessions. A session that resumes while the plan
  file vanished asks for a new name. A headless session falls back to
  `plan.md`.

## Safety model

- Bash commands must start with a read-only allowlisted command and must
  not match a destructive pattern (`rm`, `sudo`, `git commit`, redirects,
  and so on). The allowlist is the real gate; the destructive patterns are
  a second line of defense and are not a full parser.
- `write` and `edit` are gated by basename comparison against the locked
  plan file. A path like `../plan.md` is allowed; a path like
  `dir/plan.md` is blocked (the basename check only sees `plan.md`).
