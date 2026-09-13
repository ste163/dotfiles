# file-path-rules

Declarative glob-to-doc reminders for pi. When the model touches a file
with read, edit, or write, the matching rule docs append to the tool
result content. The model sees the rule right after the touch.

## Config

One file per rule in `.pi/rules/*.md`. A `paths:` front-matter field
holds a string or a list of glob patterns. The body of the file is the
reminder.

```yaml
---
paths: "src/pages/**"
---
Invoke the `/app-domain` skill before editing any page logic.
```

Files without a `paths:` field are not rules and are skipped. Invalid
files produce a warning notification and are skipped.

## Glob vocabulary

- `**` as a whole segment: zero or more directories.
- `*`: any run of non-slash chars, dots included.
- `?`: one non-slash char.
- `{a,b}`: alternation.
- Every other char matches literally.

## Behavior

- Watches the built-in read, edit, and write tools.
- Fires once per file per session. The dedupe is per file: a second touch
  of the same file stays silent, a different file under the same rule
  fires again.
- Reminders append to the tool result content, one text block per matched
  rule, in rule file order.
- Rules load only for trusted projects. An untrusted project loads
  nothing and the extension stays inert.

## Tests

Spec files colocate with the code. Tests use fake pi and fake ctx
objects with in-memory deps. No real disk I/O.
