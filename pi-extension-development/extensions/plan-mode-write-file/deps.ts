import { existsSync } from "node:fs";

/** Filesystem access the extension needs (the PlanModeWriteFileDeps pattern). */
export interface PlanModeWriteFileDeps {
  existsSync(path: string): boolean;
  cwd(): string;
}

/** Default deps: the real filesystem. A plain immutable value. */
export const defaultDeps: PlanModeWriteFileDeps = {
  existsSync,
  cwd: () => process.cwd(),
};
