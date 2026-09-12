import type { TodoItem } from "./utils.ts";

interface CustomMessage {
  customType: string;
  content: string;
  display: boolean;
}

export const planContextMessage = (planFileName: string): CustomMessage => ({
  customType: "plan-write-file-context",
  content: `[PLAN WRITE FILE ACTIVE]
You are in plan-write-file mode: read-only exploration with one writable plan file.

Restrictions:
- Bash is restricted to an allowlist of read-only commands
- The only file you may write or edit is ${planFileName} (any other write/edit is blocked)

Create a detailed numbered plan under a "Plan:" header and write it to ${planFileName}:

Plan:
1. First step description
2. Second step description
...

Do NOT make other changes - just describe what you would do.`,
  display: false,
});

export const executionContextMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-write-file-execution-context",
  content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todos.flatMap((t) => (t.completed ? [] : [`${t.step}. ${t.text}`])).join("\n")}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
  display: false,
});

export const todoListMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-write-file-todo-list",
  content: `**Plan Steps (${todos.length}):**\n\n${todos
    .map((t, i) => `${i + 1}. [ ] ${t.text}`)
    .join("\n")}`,
  display: true,
});

export const executeMessage = (todos: TodoItem[], first: string): CustomMessage => ({
  customType: "plan-write-file-execute",
  content: `Execute the plan.

Remaining steps:
${todos.map((t) => `${t.step}. ${t.text}`).join("\n")}

Start with: ${first}
After completing a step, include a [DONE:n] tag in your response.`,
  display: true,
});

export const completeMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-write-file-complete",
  content: `**Plan Complete!**\n\n${todos.map((t) => `~~${t.text}~~`).join("\n")}`,
  display: true,
});
