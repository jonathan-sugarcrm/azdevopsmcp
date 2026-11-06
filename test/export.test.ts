import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Audit, AuditEntry } from "../src/audit.js";
import type { AzdoClient } from "../src/azdo-client.js";
import { parseConfig } from "../src/config.js";
import { AzdoError } from "../src/errors.js";
import { MAX_EXPORT_BYTES, safePart, writeExport } from "../src/export.js";
import { finish, finishSized, MAX_BYTES, runTool, type Ctx } from "../src/tools/run.js";

const base = {
  orgUrl: "https://dev.azure.com/sales-i",
  vsrmUrl: "https://vsrm.dev.azure.com/sales-i",
  allowedProjects: ["Orion"],
  patRef: "op://Claude/AZDO_PAT_READ/notesPlain",
  auditLogPath: "/unused/audit.log",
  maxCallsPerMinute: 60,
};

// Pretty-printed size above the 200 KB inline cap. Spaces stop any PAT-shaped run.
const big = { id: 199, blob: "lorem ipsum ".repeat(20000) };
const fixed = { now: () => new Date("2026-11-06T17:14:00.000Z"), randomHex: () => "a1b2c3d4" };

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "azdo-export-test-"));
}

function setup(exportDir: string) {
  const entries: AuditEntry[] = [];
  const audit: Audit = { write: (e) => void entries.push(e) };
  const client = { takeStatuses: () => [200] } as unknown as AzdoClient;
  const ctx: Ctx = { cfg: parseConfig({ ...base, exportDir }), client, audit };
  return { ctx, entries };
}

/** Run fn and return the AzdoError it threw. Fails the test if it did not throw an AzdoError. */
function errorOf(fn: () => unknown): AzdoError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AzdoError) return e;
    throw e;
  }
  throw new Error("expected an AzdoError");
}

describe("finishSized (SPEC 3, 3b)", () => {
  it("returns small output inline, with no file written", () => {
    const root = tmpRoot();
    const dir = join(root, "exports");
    const { ctx } = setup(dir);
    const out = finishSized(ctx, "get_release_definition", "Orion", "199", { a: 1 });
    expect(out.data).toEqual({ a: 1 });
    expect(out.savedTo).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("writes an over-200 KB result to a file: no data, full redacted JSON, fullSize in bytes", () => {
    const root = tmpRoot();
    const dir = join(root, "exports");
    const { ctx } = setup(dir);
    const out = finishSized(ctx, "get_release_definition", "Orion", "199", big);
    expect(out.data).toBeUndefined();
    expect(out.truncated).toBe(true);
    const text = JSON.stringify(big, null, 2);
    expect(out.fullSize).toBe(Buffer.byteLength(text, "utf8"));
    expect(out.savedTo).toBeTruthy();
    expect(readFileSync(out.savedTo!, "utf8")).toBe(text);
    expect(JSON.parse(readFileSync(out.savedTo!, "utf8"))).toEqual(big);
  });

  it("writes the export file with mode 0600 in a 0700 directory", () => {
    const root = tmpRoot();
    const dir = join(root, "exports");
    const { ctx } = setup(dir);
    const out = finishSized(ctx, "get_release_definition", "Orion", "199", big);
    expect(statSync(out.savedTo!).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("masks secret values in the export file", () => {
    const root = tmpRoot();
    const { ctx } = setup(join(root, "exports"));
    const withSecret = { variables: { DB: { value: "topsecretvalue", isSecret: true } }, blob: big.blob };
    const out = finishSized(ctx, "get_release_definition", "Orion", "199", withSecret);
    const text = readFileSync(out.savedTo!, "utf8");
    expect(text).not.toContain("topsecretvalue");
    expect(JSON.parse(text).variables.DB.value).toBe("***");
  });

  it("measures bytes, not characters: 120K multi-byte characters go to a file", () => {
    const root = tmpRoot();
    const { ctx } = setup(join(root, "exports"));
    const accents = { s: "é".repeat(120 * 1024) }; // 122,880 chars, about 245 KB in UTF-8
    expect(JSON.stringify(accents, null, 2).length).toBeLessThan(MAX_BYTES);
    const out = finishSized(ctx, "get_release_definition", "Orion", "199", accents);
    expect(out.savedTo).toBeTruthy();
    expect(out.data).toBeUndefined();
  });

  it("returns export_too_large with fullSize over 5 MB, and writes nothing", () => {
    const root = tmpRoot();
    const dir = join(root, "exports");
    const { ctx } = setup(dir);
    const huge = { blob: "lorem ipsum ".repeat(Math.ceil((MAX_EXPORT_BYTES + 10) / 12)) };
    const err = errorOf(() => finishSized(ctx, "get_release_definition", "Orion", "199", huge));
    expect(err.code).toBe("export_too_large");
    expect(err.details?.fullSize).toBeGreaterThan(MAX_EXPORT_BYTES);
    expect(existsSync(dir)).toBe(false);
  });

  it("returns export_failed when exportDir cannot be created, and leaves no file", () => {
    const root = tmpRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const { ctx } = setup(join(blocker, "exports"));
    const err = errorOf(() => finishSized(ctx, "get_release_definition", "Orion", "199", big));
    expect(err.code).toBe("export_failed");
    expect(readdirSync(root)).toEqual(["blocker"]);
  });
});

describe("writeExport", () => {
  it("never overwrites: a second write with the same name fails and the first file is unchanged", () => {
    const dir = join(tmpRoot(), "exports");
    const first = writeExport({ dir, tool: "t", project: "Orion", key: "1", json: "first", ...fixed });
    const err = errorOf(() => writeExport({ dir, tool: "t", project: "Orion", key: "1", json: "second", ...fixed }));
    expect(err.code).toBe("export_failed");
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("keeps the project and key in the file name to [A-Za-z0-9_-], with no path escape", () => {
    const dir = join(tmpRoot(), "exports");
    const path = writeExport({
      dir,
      tool: "get_release_definition",
      project: "../Or/ion x",
      key: "../../etc/passwd",
      json: "{}",
      ...fixed,
    });
    expect(dirname(path)).toBe(dir);
    expect(basename(path)).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    expect(basename(path)).toBe(
      "get_release_definition-___Or_ion_x-______etc_passwd-2026-11-06T17-14-00Z-a1b2c3d4.json",
    );
  });

  it("caps the key part of the file name at 64 characters", () => {
    const dir = join(tmpRoot(), "exports");
    const path = writeExport({ dir, tool: "t", project: "Orion", key: "k".repeat(100), json: "{}", ...fixed });
    expect(basename(path).split("-")[2]).toHaveLength(64);
  });

  it("safePart replaces every character outside [A-Za-z0-9_-]", () => {
    expect(safePart("a/b..c d")).toBe("a_b__c_d");
  });
});

describe("finish (row-capped) and runTool audit", () => {
  it("finish() never cuts or writes, even above 200 KB", () => {
    const out = finish(big);
    expect(out.data).toEqual(big);
    expect(out.truncated).toBeUndefined();
    expect(out.savedTo).toBeUndefined();
  });

  it("audits saved_to when a file was written, and returns the export error with fullSize", async () => {
    const root = tmpRoot();
    const { ctx, entries } = setup(join(root, "exports"));
    const args = { project: "Orion", id: 199 };

    const ok = await runTool(ctx, "get_release_definition", args, async () =>
      finishSized(ctx, "get_release_definition", "Orion", "199", big),
    );
    const okBody = JSON.parse(ok.content[0].text);
    expect(okBody.savedTo).toBeTruthy();
    expect(okBody.data).toBeUndefined();
    expect(entries[0].saved_to).toBe(okBody.savedTo);
    expect(entries[0].outcome).toBe("ok");

    const huge = { blob: "lorem ipsum ".repeat(Math.ceil((MAX_EXPORT_BYTES + 10) / 12)) };
    const bad = await runTool(ctx, "get_release_definition", args, async () =>
      finishSized(ctx, "get_release_definition", "Orion", "199", huge),
    );
    expect(bad.isError).toBe(true);
    const badBody = JSON.parse(bad.content[0].text);
    expect(badBody.error).toBe("export_too_large");
    expect(badBody.fullSize).toBeGreaterThan(MAX_EXPORT_BYTES);
    expect(entries[1].saved_to).toBeUndefined();
    expect(entries[1].outcome).toBe("export_too_large");
  });
});
