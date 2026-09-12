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
   notification. It does not block the session.
5. A bad config disables the hooks and shows a warning at session start.

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
stderr become the reason.

### agent_settled

| Field     | Meaning                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `command` | The shell command to run. No payload argument.                                                                     |
| `when`    | `"dirty"` to run only after the session edited a matching path. Omit to run on every settle.                       |
| `paths`   | Required with `"dirty"`. A pattern ending in `/**` matches by directory prefix. Any other pattern matches exactly. |
| `status`  | Optional label. Shows a status widget below the editor (running, complete, failed).                                |
| `timeout` | Time limit in milliseconds. Default: 120000.                                                                       |

A failure shows a notification with the hook output. It does not block the
session. With `"dirty"`, the flag clears after the hook runs, success or
failure. If the hook never ran, the flag stays and the next settle retries.

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

