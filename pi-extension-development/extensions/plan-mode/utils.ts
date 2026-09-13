/**
 * Pure utility functions for plan-mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode. Best-effort guardrail, not a
// security boundary: a pattern list can be bypassed, so treat it as one
// layer of defense, not the only one.
const DESTRUCTIVE_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /-delete\b/,
  /-execdir\b/,
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)(?!\s*(\/dev\/null\b|&[12]\b))/,
  />>(?!\s*\/dev\/null\b)/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*cd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

export const isSafeCommand = (command: string): boolean => {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
};

export const DEFAULT_PLAN_FILE_NAME = "plan.md";

// The plan file always lives in the session cwd, so directory parts a user
// types are discarded rather than honored. split() always yields at least
// one element, so pop() is defined.
export const toBaseName = (path: string): string => path.split(/[/\\]/).pop() as string;

export const withMdExt = (name: string): string => (/\.[^./\\]+$/.test(name) ? name : `${name}.md`);

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

const stripLeadingVerb = (text: string): string =>
  text.replace(
    /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
    "",
  );

const capitalize = (text: string): string =>
  text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;

export const cleanStepText = (text: string): string =>
  capitalize(
    stripLeadingVerb(text.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1").replace(/`([^`]+)`/g, "$1"))
      .replace(/\s+/g, " ")
      .trim(),
  );

const isPlanStepCandidate = (text: string): boolean =>
  text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-");

// A plan header is a line of its own: optional markdown hashes, then
// "Plan" with an optional colon, wrapped in optional bold markers.
// Markdown headings are natural for the model, so the parser accepts them
// instead of demanding one exact form.
const PLAN_HEADER_PATTERN = /^[ \t]*(?:#{1,6}[ \t]+)?\*{0,2}Plan:?\*{0,2}[ \t]*$/im;

// Numbered steps capture the whole line. cleanStepText strips markdown
// inside the text, so mid-line bold or code spans do not cut the capture
// short the way a stop-at-first-asterisk pattern would.
const NUMBERED_STEP_PATTERN = /^[ \t]*(\d+)[.)][ \t]+(.+?)[ \t]*$/gm;

const stripBoldMarkers = (text: string): string =>
  text
    .replace(/^\*{1,2}/, "")
    .replace(/\*{1,2}$/, "")
    .trim();

export const extractTodoItems = (message: string): TodoItem[] => {
  const headerMatch = message.match(PLAN_HEADER_PATTERN);
  if (!headerMatch) return [];

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);

  return Array.from(planSection.matchAll(NUMBERED_STEP_PATTERN))
    .map((match) =>
      // SAFETY: the regex requires (.+?) to match, so group 2 is present.
      stripBoldMarkers(match[2] as string),
    )
    .flatMap((text) => (isPlanStepCandidate(text) ? [cleanStepText(text)] : []))
    .filter((cleaned) => cleaned.length > 3)
    .map((text, index) => ({ step: index + 1, text, completed: false }));
};

/**
 * Names the exact reason a message does not parse as a plan, or null when
 * it does. Callers show the reason to the user and the model, so a failed
 * parse always carries an actionable fix instead of a dead end.
 */
export const planFormatIssue = (message: string): string | null => {
  const headerMatch = message.match(PLAN_HEADER_PATTERN);
  if (!headerMatch) return "missing a 'Plan:' header line at the end of the response";

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const numbered = planSection.match(/^[ \t]*\d+[.)][ \t]+.+/gm);
  if (numbered === null) return "no numbered steps after the 'Plan:' header";

  return extractTodoItems(message).length === 0
    ? "numbered steps could not be parsed into plan steps"
    : null;
};

export const extractDoneSteps = (message: string): number[] =>
  Array.from(message.matchAll(/\[DONE:(\d+)\]/gi)).flatMap((match) => {
    const step = Number(match[1]);
    return Number.isFinite(step) ? [step] : [];
  });

/**
 * Pure: returns a new list, never mutates the input. The count is how many
 * steps changed, not how many markers matched, so callers only refresh the
 * UI when something actually flipped.
 */
export const markCompletedSteps = (
  text: string,
  items: TodoItem[],
): { todos: TodoItem[]; completed: number } => {
  const doneSteps = extractDoneSteps(text);
  const todos = items.map((item) =>
    doneSteps.includes(item.step) && !item.completed ? { ...item, completed: true } : item,
  );
  const completed = todos.reduce(
    (count, item, index) => (item.completed && !items[index]?.completed ? count + 1 : count),
    0,
  );
  return { todos, completed };
};
