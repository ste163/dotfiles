import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Filesystem access the extension needs (the PlanModeDeps pattern). */
export interface PlanModeDeps {
  existsSync(path: string): boolean;
  /** File contents; null when the file is missing or unreadable. */
  readFileSync(path: string): string | null;
  /** True when the file was written. */
  writeFileSync(path: string, content: string): boolean;
  cwd(): string;
}

/** Filesystem functions the default deps use, injectable for tests. */
interface PlanModeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, content: string): void;
}

const realFs: PlanModeFs = { existsSync, readFileSync, writeFileSync };

/** Default deps built on a filesystem, injectable for tests. */
export const defaultDeps = (fs: PlanModeFs = realFs): PlanModeDeps => ({
  existsSync: (path) => fs.existsSync(path),
  readFileSync: (path) => {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFileSync: (path, content) => {
    try {
      fs.writeFileSync(path, content);
      return true;
    } catch {
      return false;
    }
  },
  cwd: () => process.cwd(),
});
