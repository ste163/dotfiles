import { existsSync, readFileSync } from "node:fs";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** External state the hooks extension needs */
export interface HooksDeps {
  exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
  ): Promise<ExecResult>;
  readFile(path: string): string | null;
}

/** Filesystem functions the default deps use, injectable for tests. */
interface HooksFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
}

/** Default deps: pi's exec plus the real filesystem. */
const realFs: HooksFs = { existsSync, readFileSync };

export const defaultDeps = (pi: ExtensionAPI, fs: HooksFs = realFs): HooksDeps => ({
  exec: (command, args, options) => pi.exec(command, args, options),
  readFile: (path) => {
    if (!fs.existsSync(path)) return null;
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
});
