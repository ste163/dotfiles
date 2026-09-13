import type { TodoItem } from "./utils.ts";

interface CustomMessage {
  customType: string;
  content: string;
  display: boolean;
}

export const overviewContextMessage: CustomMessage = {
  customType: "plan-mode-overview-context",
  content: `[PLAN MODE ACTIVE]
You are in plan overview mode: a discussion-only planning phase. The write and edit tools are disabled.

Do this:
- Ask clarifying questions about the task before proposing a plan.
- Study the code as much as you need with read-only tools and commands.
- Present options and tradeoffs when the approach is not obvious.
- End with a numbered plan under a "Plan:" header, in your response only.

Do NOT write or edit any file. Do NOT attempt any change. Wait for the user to continue planning, write the plan to a file, or execute it.`,
  display: false,
};

export const planFileContextMessage = (planFileName: string): CustomMessage => ({
  customType: "plan-mode-file-context",
  content: `[PLAN MODE ACTIVE - WRITE PLAN FILE]
You are in the plan-file phase. Write the approved plan as a detailed numbered plan under a "Plan:" header and save it to ${planFileName}.

Plan:
1. First step description
2. Second step description
...

The only file you may write or edit is ${planFileName}. Do NOT make other changes.`,
  display: false,
});

export const executionContextMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-mode-execution-context",
  content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todos.flatMap((t) => (t.completed ? [] : [`${t.step}. ${t.text}`])).join("\n")}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
  display: false,
});

export const todoListMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-mode-todo-list",
  content: `**Plan Steps (${todos.length}):**\n\n${todos
    .map((t, i) => `${i + 1}. [ ] ${t.text}`)
    .join("\n")}`,
  display: true,
});

export const writePlanFileMessage = (planFileName: string): CustomMessage => ({
  customType: "plan-mode-write-file",
  content: `Write the approved plan to ${planFileName} as a numbered plan under a "Plan:" header.`,
  display: true,
});

export const executeMessage = (todos: TodoItem[], first: string): CustomMessage => ({
  customType: "plan-mode-execute",
  content: `Execute the plan.

Remaining steps:
${todos.map((t) => `${t.step}. ${t.text}`).join("\n")}

Start with: ${first}
After completing a step, include a [DONE:n] tag in your response.`,
  display: true,
});

export const completeMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-mode-complete",
  content: `**Plan Complete!**\n\n${todos.map((t) => `~~${t.text}~~`).join("\n")}`,
  display: true,
});
