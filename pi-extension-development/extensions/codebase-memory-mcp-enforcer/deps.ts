import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Filesystem access the extension needs (the PlanModeDeps pattern). */
export interface CodebaseMemoryMcpEnforcerDeps {
  existsSync(path: string): boolean;
  /** Only called for paths existsSync accepted; keeps the real dep throw-free. */
  readFile(path: string): string;
  cwd(): string;
  homeDir(): string;
}

/** Default deps: the real filesystem. A plain immutable value. */
export const defaultDeps: CodebaseMemoryMcpEnforcerDeps = {
  existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  cwd: () => process.cwd(),
  homeDir: () => homedir(),
};
