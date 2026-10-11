import type { TodoItem } from "./utils.ts";

interface CustomMessage {
  customType: string;
  content: string;
  display: boolean;
}

// The plan shape is the code proposal format: a "# Plan" header wrapping
// "## Reasoning", "## Files", "## Implementation" ("### path" blocks), and
// an optional "## Questions" section. This text is the template the model
// fills out, kept in sync with .pi/APPEND_SYSTEM.md.
export const PLAN_TEMPLATE_TEXT = `# Plan
## Reasoning
- terse why: approach, key decisions, tradeoffs, assumptions.
- surface the decision points first.

## Files
- repo-root-relative paths, one per line, annotated (new), (modify), or (delete), each with a terse one-line purpose.

## Implementation
One pseudo-code block per file, headed ### <path>.

## Questions
Only if anything is genuinely ambiguous. Omit the section when nothing needs asking. Number each question so the user can reply by number. Say "Proposed solution" under a question when you have one.`;

// The step rules shared by the execution context and the kickoff text.
// Registration goes through the plan_step_complete tool, never through
// text tags, so the tracker never has to parse prose.
const STEP_RULES_TEXT = `Step rules:
- A step is complete only when its signal arrived in this turn: a tool result, a command output, or a user message. Background events are not signals.
- Register each completed step by calling the plan_step_complete tool with the step number. One call per step, in order. The tool blocks wrong, duplicate, and out-of-order calls; read its reply.
- Never pre-claim a step, never batch calls.
- Never register in a later turn, except to answer a progress check. A progress check names each unregistered step; call plan_step_complete for each step you completed.`;

export const overviewContextMessage: CustomMessage = {
  customType: "plan-mode-overview-context",
  content: `[PLAN MODE ACTIVE]
You are in plan overview mode: a discussion-only planning phase. The write and edit tools are disabled.

Do this:
- Ask clarifying questions about the task before proposing a plan.
- Study the code as much as you need with read-only tools and commands.
- Present options and tradeoffs when the approach is not obvious.
- End with the plan as the final section of your response, in exactly this shape, with nothing after it:

${PLAN_TEMPLATE_TEXT}

After the user answers a question, fold the answer into the Reasoning section and re-emit the full plan. After any correction or redirect, re-emit the full plan updated to match.

Do NOT write or edit any file. Do NOT attempt any change. Wait for the user to continue planning, write the plan to a file, or execute it.`,
  display: false,
};

export const planFileContextMessage = (planFileName: string): CustomMessage => ({
  customType: "plan-mode-file-context",
  content: `[PLAN MODE ACTIVE - WRITE PLAN FILE]
The plan file ${planFileName} is not written yet. Write the approved plan into it now as the final content:

${PLAN_TEMPLATE_TEXT}

Fold every answered question into the Reasoning section. Do not include a Questions section in the file. Ask no questions. Stop when the file is written.

The only file you may write or edit is ${planFileName}. Do NOT make other changes.`,
  display: false,
});

export const executionContextMessage = (todos: TodoItem[]): CustomMessage => {
  const completed = todos.filter((t) => t.completed).length;
  const next = todos.find((t) => !t.completed);
  const nextLine = next ? `Next: step ${next.step} - ${next.text}` : "All steps completed.";
  const remaining = todos.flatMap((t) => (t.completed ? [] : [`${t.step}. ${t.text}`])).join("\n");
  return {
    customType: "plan-mode-execution-context",
    content: `[EXECUTING PLAN - Full tool access enabled]

Completed: ${completed}/${todos.length}.
${nextLine}

Remaining steps:
${remaining}

Execute each step in order.

${STEP_RULES_TEXT}`,
    display: false,
  };
};

export const formatCorrectionMessage = (issue: string): CustomMessage => ({
  customType: "plan-mode-plan-format",
  content: `[PLAN MODE ACTIVE]
Your last response did not parse as a plan: ${issue}.

End your response with the plan as the final section, in exactly this shape, with nothing after it:

${PLAN_TEMPLATE_TEXT}`,
  display: true,
});

export const planFileCorrectionMessage = (issue: string, planFileName: string): CustomMessage => ({
  customType: "plan-mode-plan-format",
  content: `[PLAN MODE ACTIVE]
The plan file ${planFileName} has no valid plan: ${issue}.

Write the plan into ${planFileName} as the final content:

${PLAN_TEMPLATE_TEXT}

Fold every answered question into the Reasoning section. Do not include a Questions section in the file.`,
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
  content: `${planFileName} was created blank on disk. Write the approved plan into it now as the final content:

${PLAN_TEMPLATE_TEXT}

Fold every answered question into the Reasoning section. Do not include a Questions section in the file. Ask no questions. Stop when the file is written.

${
  todos.length > 0
    ? `The approved plan:\n${todos.map((t) => `${t.step}. ${t.text}`).join("\n")}`
    : "Use the plan discussed in the conversation."
}`,
  display: true,
});

export const executeText = (todos: TodoItem[], first: string): string =>
  `Execute the plan.

Completed: 0/${todos.length}.
Next: step 1 - ${first}

Remaining steps:
${todos.map((t) => `${t.step}. ${t.text}`).join("\n")}

Start with: ${first}

${STEP_RULES_TEXT}`;

export const executeMessage = (todos: TodoItem[], first: string): CustomMessage => ({
  customType: "plan-mode-execute",
  content: `Execute the plan.

Remaining steps:
${todos.map((t) => `${t.step}. ${t.text}`).join("\n")}

Start with: ${first}
After completing a step, call the plan_step_complete tool with its number.`,
  display: true,
});

// Block reasons for invalid plan_step_complete calls. The block result is
// the tool's reply, so every reason names the exact problem and the fix.

export const stepToolPhaseReason = (): string =>
  "plan_step_complete is only available while executing a plan.";

export const stepOutOfRangeReason = (step: number | string, total: number): string =>
  `No matching step ${step}: ${total === 0 ? "the plan has no steps" : `the plan has steps 1..${total}`}.`;

export const stepAlreadyRegisteredReason = (step: number): string =>
  `Step ${step} is already registered.`;

export const stepNotNextReason = (step: number, pending: TodoItem): string =>
  `Step ${step} is not next: step ${pending.step} (${pending.text}) is still pending. Register steps in order.`;

// The tool result is the acknowledgment for a valid registration: the
// model sees the step, its file, and the live completed count.
export const registeredStepResult = (item: TodoItem, completed: number, total: number): string =>
  `Registered step ${item.step} (${item.text}). Completed: ${completed}/${total}.`;

// Sent as a user message after a run that wrote but registered no step.
// The check names every missing step with its file, so the reply never
// has to guess which step the tracker wants.
export const progressCheckText = (
  missing: TodoItem[],
  completed: number,
  total: number,
  reason: "write" | "narrowed",
): string => {
  const reasonLine =
    reason === "write"
      ? "Your last run used write or edit tools but registered no step. If you completed any listed step in that run, call the plan_step_complete tool with its number."
      : "A previous reply registered some steps; the step(s) above remain unregistered. If you completed any of them, call the plan_step_complete tool with its number.";
  return `[PLAN MODE - PROGRESS CHECK]
Completed: ${completed}/${total}.

Untagged steps:
${missing.map((item) => `- Step ${item.step} (${item.text}): call plan_step_complete(${item.step})`).join("\n")}

${reasonLine}
If no listed step completed, reply "none completed".

Do not redo any work; this is a progress check only.`;
};

// Acknowledgment for a check reply that registered nothing. The check then
// closes: the same missing set never re-fires.
export const progressAckMessage = (
  missing: number[],
  completed: number,
  total: number,
): CustomMessage => ({
  customType: "plan-mode-progress-ack",
  content: `Missing registrations: ${missing.join(", ")}. Completed: ${completed}/${total}.`,
  display: true,
});

export const completeMessage = (todos: TodoItem[]): CustomMessage => ({
  customType: "plan-mode-complete",
  content: `**Plan Complete!**\n\n${todos.map((t) => `~~${t.text}~~`).join("\n")}\n\nThis notice is automatic. The plan is done. Do not respond to it; wait for the user's next message.`,
  display: true,
});
