import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "./redact.js";

export interface AuditEntry {
  ts: string;
  tool: string;
  args: unknown;
  http: number[];
  outcome: string;
  duration_ms: number;
  truncated: boolean;
  key: "read" | "elevated";
  approval?: "confirmed" | "denied" | "not_asked";
}

export interface Audit {
  write(entry: AuditEntry): void;
}

/** One JSON line per tool call. Arguments are redacted. No bodies, headers or tokens. */
export function fileAudit(path: string): Audit {
  mkdirSync(dirname(path), { recursive: true });
  return {
    write(entry) {
      const line = JSON.stringify({ ...entry, args: redactValue(entry.args) });
      appendFileSync(path, line + "\n", { mode: 0o600 });
    },
  };
}
