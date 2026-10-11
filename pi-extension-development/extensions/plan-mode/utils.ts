/**
 * Pure utility functions for plan-mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode. Best-effort guardrail, not a
// security boundary: a pattern list can be bypassed, so treat it as one
// layer of defense, not the only one.
const DESTRUCTIVE_PATTERNS = [
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

// Commands allowed in plan mode. curl is allowed for probing local services;
// wget stays in the destructive list. The guardrail is best-effort.
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
  /^\s*curl\b/,
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

// Plan format: a tolerant "Plan" header line, then ## sections beneath it,
// then ### path blocks inside Implementation. Hash count, colons, and bold
// markers are all accepted so model drift does not fail a parse. The
// canonical shape is "# Plan" with "##" sections and "###" path blocks.
const PLAN_HEADER_PATTERN = /^[ \t]*(?:#{1,6}[ \t]+)?\*{0,2}Plan:?\*{0,2}[ \t]*$/im;

export type PlanSection = "Reasoning" | "Files" | "Implementation" | "Questions";

// Static literals: the section names never vary at runtime.
const SECTION_PATTERNS: Record<PlanSection, RegExp> = {
  Reasoning: /^[ \t]*#{1,6}[ \t]+\*{0,2}Reasoning:?\*{0,2}[ \t]*$/im,
  Files: /^[ \t]*#{1,6}[ \t]+\*{0,2}Files:?\*{0,2}[ \t]*$/im,
  Implementation: /^[ \t]*#{1,6}[ \t]+\*{0,2}Implementation:?\*{0,2}[ \t]*$/im,
  Questions: /^[ \t]*#{1,6}[ \t]+\*{0,2}Questions:?\*{0,2}[ \t]*$/im,
};

const NEXT_SECTION_PATTERN =
  /^[ \t]*#{1,6}[ \t]+\*{0,2}(?:Reasoning|Files|Implementation|Questions):?\*{0,2}[ \t]*$/im;

// Any heading line counts as a path block; the exact level is not checked.
const PATH_BLOCK_PATTERN = /^[ \t]*#{1,6}[ \t]+\S/m;

// Files entries: a whitespace-delimited path, an optional
// "(new|modify|delete)" annotation, then an optional "— purpose" tail.
// The separator is a dash or colon after whitespace, or a colon directly
// after the annotation, so "(new): purpose" also parses. A leading list
// bullet (or nested bullets) is tolerated.
const PATH_PATTERN = /^\S+/;

const ANNOTATION_PATTERN = /^[ \t]+\((new|modify|delete)\)/;

const PURPOSE_SEPARATOR_PATTERN = /^(?:[ \t]+[—–:-]|:)[ \t]+(.+)$/;

const NUMBERED_ITEM_PATTERN = /^[ \t]*\d+[.)][ \t]+/m;

interface SectionMatch {
  content: string;
}

/** Returns the text between a section heading and the next heading. */
const findSection = (text: string, name: PlanSection): SectionMatch | null => {
  const header = text.match(SECTION_PATTERNS[name]);
  if (!header || header.index === undefined) return null;
  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const next = rest.match(NEXT_SECTION_PATTERN);
  return { content: next && next.index !== undefined ? rest.slice(0, next.index) : rest };
};

interface FileEntry {
  path: string;
  purpose: string | null;
}

const parseFileEntries = (filesSection: string): FileEntry[] =>
  filesSection.split("\n").flatMap((line) => {
    const stripped = line.replace(/^(?:[ \t]*[-*+][ \t]+)+/, "").trim();
    if (!stripped) return [];

    const pathMatch = stripped.match(PATH_PATTERN);
    if (!pathMatch) return [];
    const path = pathMatch[0] as string;
    const rest = stripped.slice(path.length);

    const annotationMatch = rest.match(ANNOTATION_PATTERN);
    const restAfterAnnotation = annotationMatch ? rest.slice(annotationMatch[0].length) : rest;

    const purposeMatch = restAfterAnnotation.match(PURPOSE_SEPARATOR_PATTERN);
    const purpose = purposeMatch ? (purposeMatch[1] as string).trim() : null;

    // A line with trailing junk after the path is prose, not an entry.
    if (!annotationMatch && !purposeMatch && restAfterAnnotation.trim() !== "") return [];

    return [{ path, purpose }];
  });

/** Steps are the Files entries, in order, labeled "path: purpose". */
export const extractTodoItems = (message: string): TodoItem[] => {
  const planHeader = message.match(PLAN_HEADER_PATTERN);
  if (!planHeader) return [];
  const afterPlan = message.slice((planHeader.index ?? 0) + planHeader[0].length);
  const files = findSection(afterPlan, "Files");
  if (!files) return [];
  return parseFileEntries(files.content).map((entry, index) => ({
    step: index + 1,
    text: entry.purpose ? `${entry.path}: ${entry.purpose}` : entry.path,
    completed: false,
  }));
};

/**
 * True when the plan still has a Questions section with numbered items.
 * Callers hide Execute while questions are open, so the user answers them
 * and the model folds the answers back into Reasoning.
 */
export const hasOpenQuestions = (message: string): boolean => {
  const planHeader = message.match(PLAN_HEADER_PATTERN);
  if (!planHeader) return false;
  const afterPlan = message.slice((planHeader.index ?? 0) + planHeader[0].length);
  const questions = findSection(afterPlan, "Questions");
  if (!questions) return false;
  return NUMBERED_ITEM_PATTERN.test(questions.content);
};

/**
 * Names the exact reason a message does not parse as a plan, or null when
 * it does. Callers show the reason to the user and the model, so a failed
 * parse always carries an actionable fix instead of a dead end.
 */
export const planFormatIssue = (message: string): string | null => {
  const planHeader = message.match(PLAN_HEADER_PATTERN);
  if (!planHeader) return "missing a '# Plan' header line at the end of the response";
  const afterPlan = message.slice((planHeader.index ?? 0) + planHeader[0].length);
  for (const name of ["Reasoning", "Files", "Implementation"] as const) {
    if (!findSection(afterPlan, name)) return `missing a '## ${name}' section`;
  }
  // SAFETY: the checks above found the Files and Implementation sections.
  const files = findSection(afterPlan, "Files") as SectionMatch;
  if (parseFileEntries(files.content).length === 0) {
    return "the '## Files' section has no file entries like 'path (modify) — purpose'";
  }
  const implementation = findSection(afterPlan, "Implementation") as SectionMatch;
  if (!PATH_BLOCK_PATTERN.test(implementation.content)) {
    return "the '## Implementation' section has no '### path' blocks";
  }
  return null;
};

/** Steps that are still unregistered, in plan order. */
export const missingSteps = (items: TodoItem[]): TodoItem[] =>
  items.filter((item) => !item.completed);

/** Same members in both lists, order-independent. */
export const sameNumbers = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((n) => b.includes(n));
