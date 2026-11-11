import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileAudit } from "./audit.js";
import { readPat } from "./auth.js";
import { AzdoClient } from "./azdo-client.js";
import { expandHome, loadConfig } from "./config.js";
import { getReleaseDefinition, listReleaseDefinitions } from "./tools/definitions.js";
import { runTool, type Ctx } from "./tools/run.js";

type ToolResult = Awaited<ReturnType<typeof runTool>>;
type GetCtx = () => Promise<Ctx>;

/** Tool calls wait for `getCtx`; the MCP handshake and tool listing never do. */
export function buildServer(getCtx: GetCtx): McpServer {
  const server = new McpServer({ name: "azdevopsmcp", version: "0.1.0" });

  server.registerTool(
    "list_release_definitions",
    {
      description:
        "List release definitions (id, name, path, revision) in an allowlisted project. Optional name filter. Read-only.",
      inputSchema: { project: z.string(), name: z.string().optional() },
    },
    (a) =>
      withCtx(getCtx, (ctx) => runTool(ctx, "list_release_definitions", a, () => listReleaseDefinitions(ctx, a))),
  );

  server.registerTool(
    "get_release_definition",
    {
      description:
        "Get one release definition by numeric id, with task groups expanded. Secret values are masked. Read-only.",
      inputSchema: { project: z.string(), id: z.number().int().positive() },
    },
    (a) => withCtx(getCtx, (ctx) => runTool(ctx, "get_release_definition", a, () => getReleaseDefinition(ctx, a))),
  );

  return server;
}

/** A failed PAT read becomes a tool error. Nothing is cached, so the next call retries the read. */
async function withCtx(getCtx: GetCtx, run: (ctx: Ctx) => Promise<ToolResult>): Promise<ToolResult> {
  let ctx: Ctx;
  try {
    ctx = await getCtx();
  } catch (e) {
    const message = e instanceof Error ? e.message : "PAT unavailable";
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "pat_unavailable", message }) }] };
  }
  return run(ctx);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const audit = fileAudit(expandHome(cfg.auditLogPath));
  // The PAT is read on the first tool call, not at startup, so launching Claude never triggers 1Password.
  let pending: Promise<Ctx> | undefined;
  const getCtx: GetCtx = () => {
    pending ??= readPat(cfg.patRef)
      .then((pat) => ({ cfg, audit, client: new AzdoClient({ pat, maxCallsPerMinute: cfg.maxCallsPerMinute }) }))
      .catch((e) => {
        pending = undefined;
        throw e;
      });
    return pending;
  };
  await buildServer(getCtx).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("Startup failed:", e instanceof Error ? e.message : "unknown error");
    process.exit(1);
  });
}
