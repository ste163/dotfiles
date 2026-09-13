import { readFileSync, readdirSync } from "node:fs";

/** External state the file-path-rules extension needs (the PlanModeDeps pattern). */
export interface FilePathRulesDeps {
  readFile(path: string): string | null;
  /** File names in a directory; null when the directory is missing or unreadable. */
  readdir(path: string): string[] | null;
}

/** Filesystem functions the default deps use, injectable for tests. */
interface FilePathRulesFs {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
}

/** Default deps: the real filesystem, with the fs injectable for tests. */
const realFs: FilePathRulesFs = { readFileSync, readdirSync };

export const defaultDeps = (fs: FilePathRulesFs = realFs): FilePathRulesDeps => ({
  readFile: (path) => {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  readdir: (path) => {
    try {
      return fs.readdirSync(path);
    } catch {
      return null;
    }
  },
});
