import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  cleanStepText,
  DEFAULT_PLAN_FILE_NAME,
  extractDoneSteps,
  extractTodoItems,
  isSafeCommand,
  markCompletedSteps,
  toBaseName,
  type TodoItem,
  withMdExt,
} from "./utils.ts";

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

  await t.test("blocks redirects", () => {
    assert.equal(isSafeCommand("echo hi > file.txt"), false);
    assert.equal(isSafeCommand("echo hi >> file.txt"), false);
  });

  await t.test("allows redirects to /dev/null", () => {
    assert.equal(isSafeCommand("echo hi > /dev/null"), true);
  });
});

test("cleanStepText", async (t) => {
  await t.test("strips markdown emphasis and code spans", () => {
    assert.equal(cleanStepText("**Run** the `build` script"), "Build script");
  });

  await t.test("strips leading action verbs", () => {
    assert.equal(cleanStepText("Create the new file"), "New file");
  });

  await t.test("collapses whitespace and capitalizes", () => {
    assert.equal(cleanStepText("  multiple   spaces  "), "Multiple spaces");
  });

  await t.test("truncates long text with ellipsis", () => {
    const long = "x".repeat(80);
    const result = cleanStepText(long);
    assert.equal(result.length, 50);
    assert.ok(result.endsWith("..."));
  });
});

test("extractTodoItems", async (t) => {
  await t.test("returns empty array when there is no Plan: header", () => {
    assert.deepEqual(extractTodoItems("just some text"), []);
  });

  await t.test("extracts numbered steps under a Plan: header", () => {
    const message = "Plan:\n1. First step here\n2. Second step here\n3. Third step here";
    const items = extractTodoItems(message);
    assert.equal(items.length, 3);
    assert.equal(items[0]?.step, 1);
    assert.equal(items[0]?.text, "First step here");
    assert.equal(items[0]?.completed, false);
  });

  await t.test("ignores short or non-step lines", () => {
    const message = "Plan:\n1. ok\n2. `code span line`\n3. - dash line\n4. A real actionable step";
    const items = extractTodoItems(message);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, "A real actionable step");
  });
});

test("extractDoneSteps", async (t) => {
  await t.test("extracts DONE markers", () => {
    assert.deepEqual(extractDoneSteps("did step [DONE:1] and [DONE:3]"), [1, 3]);
  });

  await t.test("returns empty array when there are no markers", () => {
    assert.deepEqual(extractDoneSteps("nothing done yet"), []);
  });
});

test("markCompletedSteps", async (t) => {
  await t.test("marks matching steps as completed and returns count", () => {
    const items: TodoItem[] = [
      { step: 1, text: "a", completed: false },
      { step: 2, text: "b", completed: false },
    ];
    const count = markCompletedSteps("finished [DONE:1]", items);
    assert.equal(count, 1);
    assert.equal(items[0]?.completed, true);
    assert.equal(items[1]?.completed, false);
  });

  await t.test("ignores DONE markers with no matching step", () => {
    const items: TodoItem[] = [{ step: 1, text: "a", completed: false }];
    const count = markCompletedSteps("[DONE:99]", items);
    assert.equal(count, 1);
    assert.equal(items[0]?.completed, false);
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
