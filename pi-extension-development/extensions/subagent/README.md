# subagent — vendored from pi's examples

Vendored byte-identical from pi 1.6.0:
`examples/extensions/subagent/{index.ts,agents.ts}` in the
`@earendil-works/pi-coding-agent` package.

Purpose: delegate tasks to a pi subprocess running on another model.
The `worker` agent (see `.pi/agents/worker.md`) runs on the SteamOS
Strata endpoint; the main session plans and reviews.

Planned follow-up: split into deps/utils/messages modules with
injectable dependencies and full spec coverage, matching the other
extensions in this project. Until then this directory carries a
minimal spec (`agents.spec.ts`, `formatAgentList` only), and the
coverage gate will flag it.
