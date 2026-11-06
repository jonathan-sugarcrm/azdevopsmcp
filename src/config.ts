import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";

const OP_REF = /^op:\/\/.+/;

const schema = z.strictObject({
  orgUrl: z.string().url(),
  vsrmUrl: z.string().url(),
  allowedProjects: z.array(z.string().min(1)).min(1),
  patRef: z.string().regex(OP_REF, "patRef must start with op://"),
  elevatedPatRef: z.string().regex(OP_REF, "elevatedPatRef must start with op://").optional(),
  auditLogPath: z.string().min(1),
  exportDir: z.string().min(1).default("~/.local/share/azdo-mcp/exports"),
  maxCallsPerMinute: z.number().int().positive().max(600),
});

export type Config = z.infer<typeof schema>;

export function expandHome(p: string): string {
  return p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

export function parseConfig(raw: unknown): Config {
  const cfg = schema.parse(raw);
  if (new URL(cfg.orgUrl).host !== "dev.azure.com") throw new Error("orgUrl host must be dev.azure.com");
  if (new URL(cfg.vsrmUrl).host !== "vsrm.dev.azure.com") throw new Error("vsrmUrl host must be vsrm.dev.azure.com");
  if (cfg.elevatedPatRef && cfg.elevatedPatRef === cfg.patRef) {
    throw new Error("elevatedPatRef must differ from patRef");
  }
  return {
    ...cfg,
    orgUrl: cfg.orgUrl.replace(/\/$/, ""),
    vsrmUrl: cfg.vsrmUrl.replace(/\/$/, ""),
    exportDir: expandHome(cfg.exportDir),
  };
}

export function loadConfig(path = process.env.AZDO_MCP_CONFIG ?? "~/.config/azdo-mcp/config.json"): Config {
  return parseConfig(JSON.parse(readFileSync(expandHome(path), "utf8")));
}

/** Exact, case-insensitive match against the allowlist. Returns the canonical name. */
export function allowedProject(cfg: Config, project: string): string | undefined {
  return cfg.allowedProjects.find((p) => p.toLowerCase() === project.toLowerCase());
}
