import { existsSync } from "node:fs";

/** Filesystem access the extension needs (the PlanModeDeps pattern). */
export interface PlanModeDeps {
  existsSync(path: string): boolean;
  cwd(): string;
}

/** Default deps: the real filesystem. A plain immutable value. */
export const defaultDeps: PlanModeDeps = {
  existsSync,
  cwd: () => process.cwd(),
};
