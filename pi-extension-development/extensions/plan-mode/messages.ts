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
- Write one action per step. Split steps that end at different times.
- End with a numbered plan under a "Plan:" header, as the final section of your response. Put nothing after the numbered steps.

Do NOT write or edit any file. Do NOT attempt any change. Wait for the user to continue planning, write the plan to a file, or execute it.`,
  display: false,
};

export const planFileContextMessage = (planFileName: string): CustomMessage => ({
  customType: "plan-mode-file-context",
  content: `[PLAN MODE ACTIVE - WRITE PLAN FILE]
The plan file ${planFileName} is not written yet. Write the approved plan into it now as a numbered plan under a "Plan:" header. Ask no questions. Stop when the file is written.

The only file you may write or edit is ${planFileName}. Do NOT make other changes.`,
  display: false,
});

export const executionContextMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-mode-execution-context",
  content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todos.flatMap((t) => (t.completed ? [] : [`${t.step}. ${t.text}`])).join("\n")}

Execute each step in order.

Step rules:
- A step is complete only when its signal arrived in this turn: a tool result, a command output, or a user message. Background events are not signals.
- Mark exactly one [DONE:n] tag per step, in the same turn that completes it.
- Never batch tags, never pre-claim a step, never tag in a later turn.`,
  display: false,
});

export const formatCorrectionMessage = (issue: string): CustomMessage => ({
  customType: "plan-mode-plan-format",
  content: `[PLAN MODE ACTIVE]
Your last response did not parse as a plan: ${issue}.

End your response with the plan in exactly this format, as the final section:

Plan:
1. First step description
2. Second step description

Use a "Plan:" header line and numbered steps only. Put nothing after the numbered steps.`,
  display: true,
});

export const planFileCorrectionMessage = (issue: string, planFileName: string): CustomMessage => ({
  customType: "plan-mode-plan-format",
  content: `[PLAN MODE ACTIVE]
The plan file ${planFileName} has no valid plan: ${issue}.

Write the plan into ${planFileName} in exactly this format:

Plan:
1. First step description
2. Second step description

Use a "Plan:" header line and numbered steps only. Put nothing after the numbered steps.`,
  display: true,
});

export const todoListMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-mode-todo-list",
  content: `**Plan Steps (${todos.length}):**\n\n${todos
    .map((t, i) => `${i + 1}. [ ] ${t.text}`)
    .join("\n")}`,
  display: true,
});

export const writePlanFileMessage = (planFileName: string, todos: TodoItem[]): CustomMessage => ({
  customType: "plan-mode-write-file",
  content: `${planFileName} was created blank on disk. Write the approved plan into it now as a numbered plan under a "Plan:" header. Ask no questions. Stop when the file is written.

${
  todos.length > 0
    ? `The approved plan:\n${todos.map((t) => `${t.step}. ${t.text}`).join("\n")}`
    : "Use the plan discussed in the conversation."
}`,
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
  content: `**Plan Complete!**\n\n${todos.map((t) => `~~${t.text}~~`).join("\n")}\n\nThis notice is automatic. The plan is done. Do not respond to it; wait for the user's next message.`,
  display: true,
});
