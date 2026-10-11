import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_PLAN_FILE_NAME,
  extractDoneSteps,
  extractTodoItems,
  hasOpenQuestions,
  isSafeCommand,
  markCompletedSteps,
  planFormatIssue,
  toBaseName,
  type TodoItem,
  withMdExt,
} from "./utils.ts";

const VALID_PLAN = `# Plan
## Reasoning
- change the parser.

## Files
- src/parser.ts (modify) — parse the four sections
- src/widget.ts (new) — render the todo window

## Implementation
### src/parser.ts
extractTodoItems: read the sections.

### src/widget.ts
renderWindow: slice the list.`;

const PLAN_WITH_QUESTIONS = `${VALID_PLAN}
## Questions
1. window size?
   Proposed solution: 4
2. drop threshold?
   Proposed solution: 2
`;

test("isSafeCommand", async (t) => {
  await t.test("allows read-only allowlisted commands", () => {
    assert.equal(isSafeCommand("ls -la"), true);
    assert.equal(isSafeCommand("cat foo.txt"), true);
    assert.equal(isSafeCommand("git status"), true);
    assert.equal(isSafeCommand("rg pattern"), true);
  });

  await t.test("blocks destructive commands even if they start safely", () => {
    assert.equal(isSafeCommand("rm -rf /"), false);
    assert.equal(isSafeCommand("git commit -m x"), false);
    assert.equal(isSafeCommand("sudo ls"), false);
  });

  await t.test("blocks commands not on the allowlist at all", () => {
    assert.equal(isSafeCommand("vim file.txt"), false);
    assert.equal(isSafeCommand("some-random-binary"), false);
  });

  await t.test("allows curl and still blocks wget", () => {
    assert.equal(isSafeCommand("curl https://example.com"), true);
    assert.equal(isSafeCommand("curl -s http://localhost:11434/api/version"), true);
    assert.equal(isSafeCommand("wget -O - https://example.com"), false);
    assert.equal(isSafeCommand("wget https://example.com/file.txt"), false);
  });

  await t.test("allows curl inside compound commands but still blocks wget", () => {
    assert.equal(isSafeCommand("git status && curl -s https://y"), true);
    assert.equal(isSafeCommand("ls && wget https://y"), false);
  });

  await t.test("blocks find deletion and execdir variants", () => {
    assert.equal(isSafeCommand("find . -delete"), false);
    assert.equal(isSafeCommand("find . -execdir rm {} \\;"), false);
  });

  await t.test("blocks redirects", () => {
    assert.equal(isSafeCommand("echo hi > file.txt"), false);
    assert.equal(isSafeCommand("echo hi >> file.txt"), false);
  });

  await t.test("allows redirects to /dev/null", () => {
    assert.equal(isSafeCommand("echo hi > /dev/null"), true);
  });
});

test("extractTodoItems", async (t) => {
  await t.test("returns an empty array when there is no Plan header", () => {
    assert.deepEqual(extractTodoItems("just some text"), []);
  });

  await t.test("extracts steps from the Files section labeled path: purpose", () => {
    const items = extractTodoItems(VALID_PLAN);
    assert.deepEqual(items, [
      { step: 1, text: "src/parser.ts: parse the four sections", completed: false },
      { step: 2, text: "src/widget.ts: render the todo window", completed: false },
    ]);
  });

  await t.test("returns an empty array when the Files section is missing", () => {
    assert.deepEqual(
      extractTodoItems("# Plan\n## Reasoning\n- nothing\n## Implementation\n### src/a.ts\nx"),
      [],
    );
  });

  await t.test("accepts tolerant Plan headers", () => {
    const tolerant = `**Plan:**\n## Reasoning\n- why\n## Files\n- src/a.ts (modify) — purpose\n## Implementation\n### src/a.ts\nx`;
    assert.deepEqual(extractTodoItems(tolerant), [
      { step: 1, text: "src/a.ts: purpose", completed: false },
    ]);
  });

  await t.test("accepts any section heading level", () => {
    const leveled = `# Plan\n# Reasoning\n- why\n### Files\n- src/a.ts (modify) — purpose\n## Implementation\n#### src/a.ts\nx`;
    assert.deepEqual(extractTodoItems(leveled), [
      { step: 1, text: "src/a.ts: purpose", completed: false },
    ]);
  });

  await t.test("accepts a Files entry without an annotation", () => {
    const bare = `# Plan\n## Reasoning\n- why\n## Files\n- src/a.ts — purpose\n## Implementation\n### src/a.ts\nx`;
    assert.deepEqual(extractTodoItems(bare), [
      { step: 1, text: "src/a.ts: purpose", completed: false },
    ]);
  });

  await t.test("uses the path alone when the entry has no purpose", () => {
    const bare = `# Plan\n## Reasoning\n- why\n## Files\n- src/a.ts\n## Implementation\n### src/a.ts\nx`;
    assert.deepEqual(extractTodoItems(bare), [{ step: 1, text: "src/a.ts", completed: false }]);
  });

  await t.test("accepts a colon separator for the purpose", () => {
    const colon = `# Plan\n## Reasoning\n- why\n## Files\n- src/a.ts (new): fresh purpose\n## Implementation\n### src/a.ts\nx`;
    assert.deepEqual(extractTodoItems(colon), [
      { step: 1, text: "src/a.ts: fresh purpose", completed: false },
    ]);
  });

  await t.test("accepts a leading list bullet on Files entries", () => {
    const bullet = `# Plan\n## Reasoning\n- why\n## Files\n- - src/a.ts (modify) — purpose\n## Implementation\n### src/a.ts\nx`;
    assert.deepEqual(extractTodoItems(bullet), [
      { step: 1, text: "src/a.ts: purpose", completed: false },
    ]);
  });

  await t.test("ignores prose lines inside the Files section", () => {
    const prose = `# Plan\n## Reasoning\n- why\n## Files\nHere are the changes:\n- src/a.ts (modify) — purpose\n## Implementation\n### src/a.ts\nx`;
    assert.deepEqual(extractTodoItems(prose), [
      { step: 1, text: "src/a.ts: purpose", completed: false },
    ]);
  });

  await t.test("keeps hyphens inside paths intact", () => {
    const hyphen = `# Plan\n## Reasoning\n- why\n## Files\n- src/my-tool.ts (modify) — hyphen purpose\n## Implementation\n### src/my-tool.ts\nx`;
    assert.deepEqual(extractTodoItems(hyphen), [
      { step: 1, text: "src/my-tool.ts: hyphen purpose", completed: false },
    ]);
  });

  await t.test("numbers steps in file order", () => {
    const items = extractTodoItems(VALID_PLAN);
    assert.deepEqual(
      items.map((item) => item.step),
      [1, 2],
    );
  });
});

test("planFormatIssue", async (t) => {
  await t.test("reports a missing Plan header", () => {
    assert.equal(
      planFormatIssue("just some text"),
      "missing a '# Plan' header line at the end of the response",
    );
  });

  await t.test("reports a missing Reasoning section", () => {
    assert.equal(
      planFormatIssue(
        "# Plan\n## Files\n- src/a.ts (modify) — purpose\n## Implementation\n### src/a.ts\nx",
      ),
      "missing a '## Reasoning' section",
    );
  });

  await t.test("reports a missing Files section", () => {
    assert.equal(
      planFormatIssue("# Plan\n## Reasoning\n- why\n## Implementation\n### src/a.ts\nx"),
      "missing a '## Files' section",
    );
  });

  await t.test("reports a missing Implementation section", () => {
    assert.equal(
      planFormatIssue("# Plan\n## Reasoning\n- why\n## Files\n- src/a.ts (modify) — purpose"),
      "missing a '## Implementation' section",
    );
  });

  await t.test("reports a Files section with no entries", () => {
    assert.equal(
      planFormatIssue(
        "# Plan\n## Reasoning\n- why\n## Files\nnothing here\n## Implementation\n### src/a.ts\nx",
      ),
      "the '## Files' section has no file entries like 'path (modify) — purpose'",
    );
  });

  await t.test("reports an Implementation section with no path blocks", () => {
    assert.equal(
      planFormatIssue(
        "# Plan\n## Reasoning\n- why\n## Files\n- src/a.ts (modify) — purpose\n## Implementation\nno blocks here",
      ),
      "the '## Implementation' section has no '### path' blocks",
    );
  });

  await t.test("returns null for a valid plan", () => {
    assert.equal(planFormatIssue(VALID_PLAN), null);
  });

  await t.test("returns null for a valid plan with open questions", () => {
    assert.equal(planFormatIssue(PLAN_WITH_QUESTIONS), null);
  });
});

test("hasOpenQuestions", async (t) => {
  await t.test("returns true when the Questions section has numbered items", () => {
    assert.equal(hasOpenQuestions(PLAN_WITH_QUESTIONS), true);
  });

  await t.test("returns false when the Questions section is absent", () => {
    assert.equal(hasOpenQuestions(VALID_PLAN), false);
  });

  await t.test("returns false when the Questions section has no numbered items", () => {
    const empty = `${VALID_PLAN}\n## Questions\nNo questions left.`;
    assert.equal(hasOpenQuestions(empty), false);
  });

  await t.test("returns false without a Plan header", () => {
    assert.equal(hasOpenQuestions("## Questions\n1. what?"), false);
  });
});

test("extractDoneSteps", async (t) => {
  await t.test("extracts DONE markers", () => {
    assert.deepEqual(extractDoneSteps("did step [DONE:1] and [DONE:3]"), [1, 3]);
  });

  await t.test("returns empty array when there are no markers", () => {
    assert.deepEqual(extractDoneSteps("nothing done yet"), []);
  });

  await t.test("drops markers whose step number overflows to Infinity", () => {
    assert.deepEqual(extractDoneSteps(`[DONE:${"9".repeat(400)}]`), []);
  });
});

test("markCompletedSteps", async (t) => {
  await t.test("returns the new list with matching steps completed and the count", () => {
    const items: TodoItem[] = [
      { step: 1, text: "a", completed: false },
      { step: 2, text: "b", completed: false },
    ];
    const result = markCompletedSteps("finished [DONE:1]", items);
    assert.equal(result.completed, 1);
    assert.deepEqual(result.todos, [
      { step: 1, text: "a", completed: true },
      { step: 2, text: "b", completed: false },
    ]);
    assert.equal(items[0]?.completed, false);
  });

  await t.test("ignores DONE markers with no matching step", () => {
    const items: TodoItem[] = [{ step: 1, text: "a", completed: false }];
    const result = markCompletedSteps("[DONE:99]", items);
    assert.equal(result.completed, 0);
    assert.deepEqual(result.todos, items);
  });

  await t.test("does not count steps that were already completed", () => {
    const items: TodoItem[] = [{ step: 1, text: "a", completed: true }];
    const result = markCompletedSteps("[DONE:1]", items);
    assert.equal(result.completed, 0);
    assert.deepEqual(result.todos, items);
  });
});

test("toBaseName", async (t) => {
  await t.test("returns the input unchanged when there is no path separator", () => {
    assert.equal(toBaseName("plan.md"), "plan.md");
  });

  await t.test("strips unix-style directory parts", () => {
    assert.equal(toBaseName("foo/bar/plan.md"), "plan.md");
  });

  await t.test("strips windows-style directory parts", () => {
    assert.equal(toBaseName("foo\\bar\\plan.md"), "plan.md");
  });

  await t.test("strips attempted path traversal down to the basename", () => {
    assert.equal(toBaseName("../../etc/plan.md"), "plan.md");
  });
});

test("withMdExt", async (t) => {
  await t.test("appends .md when there is no extension", () => {
    assert.equal(withMdExt("my-plan"), "my-plan.md");
  });

  await t.test("leaves an existing extension alone", () => {
    assert.equal(withMdExt("my-plan.txt"), "my-plan.txt");
    assert.equal(withMdExt("my-plan.md"), "my-plan.md");
  });
});

test("DEFAULT_PLAN_FILE_NAME", () => {
  assert.equal(DEFAULT_PLAN_FILE_NAME, "plan.md");
});
