/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
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
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
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

// Default name offered when the user doesn't provide one for the plan file.
export const DEFAULT_PLAN_FILE_NAME = "plan.md";

// Strip any directory parts the user typed - plan file always lives in cwd.
export const toBaseName = (path: string): string => path.split(/[/\\]/).pop() ?? path;

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

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

export const cleanStepText = (text: string): string => {
  const stripped = stripLeadingVerb(
    text
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
      .replace(/`([^`]+)`/g, "$1"), // Remove code
  )
    .replace(/\s+/g, " ")
    .trim();

  return truncate(capitalize(stripped), 50);
};

const isPlanStepCandidate = (text: string): boolean =>
  text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-");

export const extractTodoItems = (message: string): TodoItem[] => {
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return [];

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  return Array.from(planSection.matchAll(numberedPattern)).reduce<TodoItem[]>((items, match) => {
    const text = (match[2] ?? "")
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (!isPlanStepCandidate(text)) return items;

    const cleaned = cleanStepText(text);
    if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
    return items;
  }, []);
};

export const extractDoneSteps = (message: string): number[] =>
  Array.from(message.matchAll(/\[DONE:(\d+)\]/gi), (match) => Number(match[1])).filter((step) =>
    Number.isFinite(step),
  );

export const markCompletedSteps = (text: string, items: TodoItem[]): number =>
  extractDoneSteps(text).reduce((completedCount, step) => {
    const item = items.find((t) => t.step === step);
    if (!item) return completedCount;
    item.completed = true;
    return completedCount + 1;
  }, 0);
