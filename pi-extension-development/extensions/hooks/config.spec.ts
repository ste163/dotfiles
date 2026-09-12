import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import type { HooksDeps } from "./deps.ts";

const depsWith = (raw: string | null): Pick<HooksDeps, "readFile"> => ({
  readFile: () => raw,
});

test("loadConfig returns a null config when the file is missing", () => {
  assert.deepEqual(loadConfig(depsWith(null), "/virtual/repo"), { config: null, error: null });
});

test("loadConfig reports invalid JSON with the config path", () => {
  const { config, error } = loadConfig(depsWith("not json"), "/virtual/repo");
  assert.equal(config, null);
  assert.ok(error?.includes("Invalid JSON"));
  assert.ok(error?.includes("/virtual/repo/.pi/hooks.json"));
});

test("loadConfig rejects a non-object config", () => {
  const { config, error } = loadConfig(depsWith("42"), "/virtual/repo");
  assert.equal(config, null);
  assert.ok(error?.includes("Invalid config"));
});

test("loadConfig rejects a tool_call hook without a command", () => {
  const { config, error } = loadConfig(depsWith('{"tool_call":{}}'), "/virtual/repo");
  assert.equal(config, null);
  assert.ok(error?.includes('"tool_call" requires a "command"'));
});

test("loadConfig rejects an agent_settled hook without a command", () => {
  const { config, error } = loadConfig(
    depsWith('{"agent_settled":{"when":"dirty","paths":["src/**"]}}'),
    "/virtual/repo",
  );
  assert.equal(config, null);
  assert.ok(error?.includes('"agent_settled" requires a "command"'));
});

test("loadConfig rejects an unsupported when value", () => {
  const { config, error } = loadConfig(
    depsWith('{"agent_settled":{"command":"sh v.sh","when":"always"}}'),
    "/virtual/repo",
  );
  assert.equal(config, null);
  assert.ok(error?.includes('Unsupported "when" value'));
});

test("loadConfig rejects when dirty without paths", () => {
  const { config, error } = loadConfig(
    depsWith('{"agent_settled":{"command":"sh v.sh","when":"dirty"}}'),
    "/virtual/repo",
  );
  assert.equal(config, null);
  assert.ok(error?.includes('requires a non-empty "paths"'));
});

test("loadConfig rejects when dirty with empty paths", () => {
  const { config, error } = loadConfig(
    depsWith('{"agent_settled":{"command":"sh v.sh","when":"dirty","paths":[]}}'),
    "/virtual/repo",
  );
  assert.equal(config, null);
  assert.ok(error?.includes('requires a non-empty "paths"'));
});

test("loadConfig parses a valid config", () => {
  const { config, error } = loadConfig(
    depsWith('{"tool_call":{"command":"sh x.sh"}}'),
    "/virtual/repo",
  );
  assert.equal(error, null);
  assert.deepEqual(config, { tool_call: { command: "sh x.sh" } });
});

test("loadConfig accepts when dirty with paths", () => {
  const { config, error } = loadConfig(
    depsWith('{"agent_settled":{"command":"sh v.sh","when":"dirty","paths":["src/**"]}}'),
    "/virtual/repo",
  );
  assert.equal(error, null);
  assert.deepEqual(config, {
    agent_settled: { command: "sh v.sh", when: "dirty", paths: ["src/**"] },
  });
});
