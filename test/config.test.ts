import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { readPat } from "../src/auth.js";

const good = {
  orgUrl: "https://dev.azure.com/sales-i",
  vsrmUrl: "https://vsrm.dev.azure.com/sales-i",
  allowedProjects: ["Orion"],
  patRef: "op://Claude/AZDO_PAT_READ/notesPlain",
  auditLogPath: "~/audit.log",
  maxCallsPerMinute: 60,
};

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    expect(parseConfig(good).allowedProjects).toEqual(["Orion"]);
  });
  it("defaults exportDir under ~/.local/share/azdo-mcp/exports, with ~ expanded", () => {
    const dir = parseConfig(good).exportDir;
    expect(dir).toMatch(/\.local\/share\/azdo-mcp\/exports$/);
    expect(dir.startsWith("~")).toBe(false);
  });
  it("accepts an explicit exportDir and expands ~", () => {
    expect(parseConfig({ ...good, exportDir: "/tmp/x" }).exportDir).toBe("/tmp/x");
    expect(parseConfig({ ...good, exportDir: "~/exp" }).exportDir.startsWith("~")).toBe(false);
  });
  it("rejects an empty exportDir", () => {
    expect(() => parseConfig({ ...good, exportDir: "" })).toThrow();
  });
  it("accepts an optional elevatedPatRef", () => {
    expect(parseConfig({ ...good, elevatedPatRef: "op://Claude/AZDO_PAT_ELEVATED/notesPlain" }).elevatedPatRef).toBeTruthy();
  });
  it("rejects a raw token as patRef", () => {
    expect(() => parseConfig({ ...good, patRef: "abcdefghijklmnop" })).toThrow();
  });
  it("rejects unknown keys", () => {
    expect(() => parseConfig({ ...good, pat: "x" })).toThrow();
  });
  it("rejects a wrong host", () => {
    expect(() => parseConfig({ ...good, orgUrl: "https://evil.example/sales-i" })).toThrow(/dev.azure.com/);
    expect(() => parseConfig({ ...good, vsrmUrl: "https://dev.azure.com/sales-i" })).toThrow(/vsrm/);
  });
  it("rejects an empty allowlist", () => {
    expect(() => parseConfig({ ...good, allowedProjects: [] })).toThrow();
  });
  it("rejects elevatedPatRef equal to patRef", () => {
    expect(() => parseConfig({ ...good, elevatedPatRef: good.patRef })).toThrow(/differ/);
  });
});

describe("readPat", () => {
  it("returns the token", async () => {
    expect(await readPat("op://x", vi.fn().mockResolvedValue("tok"))).toBe("tok");
  });
  it("throws when op read fails, so startup registers no tools", async () => {
    await expect(readPat("op://x", vi.fn().mockRejectedValue(new Error("no")))).rejects.toThrow();
  });
  it("throws on an empty item", async () => {
    await expect(readPat("op://x", vi.fn().mockResolvedValue(""))).rejects.toThrow();
  });
});
