import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatAgentList, type AgentConfig } from "./agents.ts";

function agent(name: string): AgentConfig {
  return {
    name,
    description: `Agent ${name}`,
    tools: undefined,
    model: undefined,
    systemPrompt: "",
    source: "user",
    filePath: `/agents/${name}.md`,
  };
}

describe("formatAgentList", () => {
  it("reports none for an empty list", () => {
    assert.deepEqual(formatAgentList([], 5), { text: "none", remaining: 0 });
  });

  it("lists every agent when the list fits", () => {
    const result = formatAgentList([agent("scout"), agent("worker")], 5);
    assert.equal(result.remaining, 0);
    assert.match(result.text, /scout \(user\): Agent scout/);
    assert.match(result.text, /worker \(user\): Agent worker/);
  });

  it("caps at maxItems and counts the remainder", () => {
    const result = formatAgentList([agent("a"), agent("b"), agent("c")], 2);
    assert.equal(result.remaining, 1);
    assert.match(result.text, /a \(user\)/);
    assert.match(result.text, /b \(user\)/);
    assert.doesNotMatch(result.text, /c \(user\)/);
  });
});
