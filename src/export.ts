import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AzdoError } from "./errors.js";

/** SPEC 3b: largest redacted JSON that will be written to an export file, in bytes. */
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

export interface ExportRequest {
  /** exportDir from config, already ~-expanded. */
  dir: string;
  tool: string;
  /** Canonical allowlisted project name. */
  project: string;
  /** Numeric id, or the name. */
  key: string;
  /** Redacted JSON, pretty-printed. Written exactly as given. */
  json: string;
  /** Injectable for tests. */
  now?: () => Date;
  /** Injectable for tests. Returns 8 hex characters in production. */
  randomHex?: () => string;
}

/** Replace every character outside [A-Za-z0-9_-]. Stops `/` and `..` reaching the path. */
export function safePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** UTC time as 2026-11-06T17-14-00Z (no milliseconds, no colons). */
function utcStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/**
 * Write the redacted JSON to a new file (SPEC 3b). Returns the full path.
 * The file is never overwritten. On failure, only a file this call created is removed.
 */
export function writeExport(req: ExportRequest): string {
  const bytes = Buffer.byteLength(req.json, "utf8");
  if (bytes > MAX_EXPORT_BYTES) throw new AzdoError("export_too_large", undefined, { fullSize: bytes });

  const now = req.now ?? (() => new Date());
  const hex = req.randomHex ?? (() => randomBytes(4).toString("hex"));
  const keyPart = safePart(req.key).slice(0, 64);
  const name = `${req.tool}-${safePart(req.project)}-${keyPart}-${utcStamp(now())}-${hex()}.json`;
  const path = join(req.dir, name);

  let fd: number | undefined;
  let created = false;
  try {
    mkdirSync(req.dir, { recursive: true, mode: 0o700 });
    fd = openSync(path, "wx", 0o600); // exclusive: fails with EEXIST if the name is taken
    created = true;
    writeFileSync(fd, req.json);
    closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already failing; the original error is reported below
      }
    }
    // Remove only what this call created. An EEXIST leaves the existing file alone.
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // nothing more to do
      }
    }
    throw new AzdoError("export_failed");
  }
  return path;
}
