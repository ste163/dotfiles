import { existsSync, readFileSync } from "node:fs";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** External state the hooks extension needs (the PlanModeDeps pattern). */
export interface HooksDeps {
  /** Run a shell command. */
  exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
  ): Promise<ExecResult>;
  /** Read a file, or null when it does not exist. */
  readFile(path: string): string | null;
  cwd(): string;
}

/** Default deps: pi's exec plus the real filesystem. */
export const defaultDeps = (pi: ExtensionAPI): HooksDeps => ({
  exec: (command, args, options) => pi.exec(command, args, options),
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  cwd: () => process.cwd(),
});
