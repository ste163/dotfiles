import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

/** Filesystem access the extension needs (the PlanModeWriteFileDeps pattern). */
export interface CodebaseMemoryMcpEnforcerDeps {
  existsSync(path: string): boolean;
  /** Only called for paths existsSync accepted; keeps the real dep throw-free. */
  readFile(path: string): string;
  /** Only called for paths existsSync accepted; keeps the real dep throw-free. */
  statSync(path: string): { mtimeMs: number; isFile: boolean };
  cwd(): string;
  homeDir(): string;
}

/** Default deps: the real filesystem. A plain immutable value. */
export const defaultDeps: CodebaseMemoryMcpEnforcerDeps = {
  existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  statSync: (path) => {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, isFile: stats.isFile() };
  },
  cwd: () => process.cwd(),
  homeDir: () => homedir(),
};
