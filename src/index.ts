import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileAudit } from "./audit.js";
import { readPat } from "./auth.js";
import { AzdoClient } from "./azdo-client.js";
import { expandHome, loadConfig } from "./config.js";
import { getReleaseDefinition, listReleaseDefinitions } from "./tools/definitions.js";
import { runTool, type Ctx } from "./tools/run.js";

export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "azdevopsmcp", version: "0.1.0" });

  server.registerTool(
    "list_release_definitions",
    {
      description:
        "List release definitions (id, name, path, revision) in an allowlisted project. Optional name filter. Read-only.",
      inputSchema: { project: z.string(), name: z.string().optional() },
    },
    (a) => runTool(ctx, "list_release_definitions", a, () => listReleaseDefinitions(ctx, a)),
  );

  server.registerTool(
    "get_release_definition",
    {
      description:
        "Get one release definition by numeric id, with task groups expanded. Secret values are masked. Read-only.",
      inputSchema: { project: z.string(), id: z.number().int().positive() },
    },
    (a) => runTool(ctx, "get_release_definition", a, () => getReleaseDefinition(ctx, a)),
  );

  return server;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pat = await readPat(cfg.patRef); // exits below with no tools if this fails
  const client = new AzdoClient({ pat, maxCallsPerMinute: cfg.maxCallsPerMinute });
  const audit = fileAudit(expandHome(cfg.auditLogPath));
  await buildServer({ cfg, client, audit }).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("Startup failed:", e instanceof Error ? e.message : "unknown error");
    process.exit(1);
  });
}
