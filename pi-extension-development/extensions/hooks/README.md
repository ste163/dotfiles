# hooks

A pi extension that runs shell commands on pi events. It follows the hooks
model of the Copilot CLI and Claude Code.

## How it works

1. The config file is `.pi/hooks.json` in the session cwd.
2. The extension loads the config lazily on the first event, once per
   session. A mid-session edit does not reload it.
3. A `tool_call` hook runs before a tool executes. A non-zero exit blocks
   the call.
4. An `agent_settled` hook runs when the agent settles. A failure shows a
   notification and is injected into the session, so the agent sees the
   output and starts a turn to fix it. It does not block the session.
5. A user abort is a hard stop. When the agent settles because the user
   pressed Escape, no settled hook runs and nothing re-engages the agent.
6. A bad config disables the hooks and shows a warning at session start.
7. Hooks run only for trusted projects. Trust granted mid-session
   activates hooks on the next event.

## Config

Example:

```json
{
  "tool_call": {
    "command": "sh scripts/hooks/block-env.sh",
    "tools": ["write", "edit"],
    "timeout": 30000
  },
  "agent_settled": {
    "command": "sh scripts/hooks/verify.sh",
    "when": "dirty",
    "paths": ["extensions/**", "package.json"],
    "status": "Verification"
  }
}
```

### tool_call

| Field     | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `command` | The shell command to run. The tool input JSON is appended as the last argument, shell-quoted. |
| `tools`   | Run only for these tool names. Default: every tool.                                           |
| `timeout` | Time limit in milliseconds. Default: 120000.                                                  |

A non-zero exit or a timeout blocks the tool call. The hook's stdout and
stderr become the reason, truncated to 300 characters.

### agent_settled

| Field     | Meaning                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` | The shell command to run. No payload argument.                                                                                                                                         |
| `when`    | `"dirty"` to run only after the session edited a matching path. Omit to run on every settle.                                                                                           |
| `paths`   | Required with `"dirty"`. A pattern ending in `/**` matches by directory prefix. Any other pattern matches exactly.                                                                     |
| `status`  | Optional label. Shows a status widget below the editor (running, complete, failed). A failed status stays until a later run passes; running and complete clear when a new turn starts. |
| `timeout` | Time limit in milliseconds. Default: 120000.                                                                                                                                           |

A failure shows a notification with the hook output, truncated to 300
characters. It does not block the session. The failure is also injected
into the session, so the agent sees the output and starts a turn to fix
it. The injected copy keeps the last 10,000 characters, so failure
details and the coverage report survive; the notification keeps the
short tail. The failed status stays visible until a later run passes. While the
last run failed, every settle re-runs the hook - even without new edits,
so a failure fixed through bash still gets re-verified. The failure
message is injected on the first failure, again when the agent edits
files and the hook still fails, and again when the failure message
changes - a new error is new information. A repeated identical failure
with no new changes only refreshes the status, so the loop cannot run
forever. A settle that fires while the hook is still running is skipped.
With `"dirty"`, the flag clears after the hook runs, success or failure.
If the hook never ran, the failure still carries the retry obligation
and the next settle re-runs. A settle caused by a user abort runs no
hook at all and sends no message - Escape is a hard stop.

## Recipes

### Block writes of a forbidden pattern

This config blocks every `write` and `edit` that touches a `.env` file:

```json
{
  "tool_call": {
    "command": "sh scripts/hooks/block-env.sh",
    "tools": ["write", "edit"]
  }
}
```

The script reads the tool input JSON from its last argument:

```sh
#!/usr/bin/env sh
# $1 is the tool input JSON.
if echo "$1" | grep -q '\.env'; then
  echo "Refusing to write .env files"
  exit 1
fi
```

A non-zero exit blocks the call. The echo text becomes the reason.

### Verify after edits

This config runs the project checklist after any edit under `extensions/`
or to a root config file:

```json
{
  "agent_settled": {
    "command": "sh scripts/hooks/verify.sh",
    "when": "dirty",
    "paths": ["extensions/**", "package.json", "tsconfig.json"],
    "status": "Verification"
  }
}
```

The hook runs once per settle, after the edits. The status widget shows the
result. A failure does not block the session.
