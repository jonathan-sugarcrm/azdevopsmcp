import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { fileAudit } from "../src/audit.js";
import { AzdoClient } from "../src/azdo-client.js";
import { parseConfig } from "../src/config.js";
import { buildServer } from "../src/index.js";
import type { Ctx } from "../src/tools/run.js";

const PAT = "SUPERSECRETPATVALUE0123456789";
const cfg = parseConfig({
  orgUrl: "https://dev.azure.com/sales-i",
  vsrmUrl: "https://vsrm.dev.azure.com/sales-i",
  allowedProjects: ["Modax", "Predict Classic"],
  patRef: "op://Claude/AZDO_PAT_READ/notesPlain",
  auditLogPath: "x",
  maxCallsPerMinute: 600,
});

type Route = (url: string) => { status?: number; body?: unknown; type?: string; headers?: Record<string, string> };

function setup(route: Route) {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const r = route(url);
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.body ?? {}), {
      status,
      headers: { "content-type": r.type ?? "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "azdo-"));
  const auditPath = join(dir, "audit.log");
  const ctx: Ctx = {
    cfg,
    client: new AzdoClient({ pat: PAT, maxCallsPerMinute: 600, fetchFn, sleep: async () => {} }),
    audit: fileAudit(auditPath),
  };
  return { ctx, urls, auditPath };
}

async function connect(ctx: Ctx) {
  const server = buildServer(ctx);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const client = await connect(ctx);
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content[0].text as string;
  return { isError: res.isError === true, text, json: JSON.parse(text) };
}

const group = (id: string, tasks: unknown[] = []) => ({ id, name: `G-${id}`, version: { major: 1 }, inputs: [], tasks });
const metaRef = (id: string) => ({ task: { id, definitionType: "metaTask" }, inputs: {} });

describe("registration", () => {
  it("registers only the read tools", async () => {
    const { ctx } = setup(() => ({}));
    const client = await connect(ctx);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_release_definition", "list_release_definitions"]);
  });
});

describe("list_release_definitions", () => {
  const body = { value: [
    { id: 7, name: "Deploy Big Boy - Tabular Model", path: "\\", revision: 3, extra: "x" },
    { id: 8, name: "Other", path: "\\", revision: 1 },
  ] };

  it("returns id, name, path and revision", async () => {
    const { ctx, urls } = setup(() => ({ body }));
    const r = await call(ctx, "list_release_definitions", { project: "Modax" });
    expect(r.json.data).toEqual([
      { id: 7, name: "Deploy Big Boy - Tabular Model", path: "\\", revision: 3 },
      { id: 8, name: "Other", path: "\\", revision: 1 },
    ]);
    expect(urls[0]).toBe("https://vsrm.dev.azure.com/sales-i/Modax/_apis/release/definitions?api-version=7.1");
  });

  it("filters by name, case-insensitive", async () => {
    const { ctx } = setup(() => ({ body }));
    const r = await call(ctx, "list_release_definitions", { project: "Modax", name: "big boy" });
    expect(r.json.data.map((d: any) => d.id)).toEqual([7]);
  });

  it("refuses a project outside the allowlist with no HTTP call", async () => {
    const { ctx, urls } = setup(() => ({ body }));
    const r = await call(ctx, "list_release_definitions", { project: "Other" });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("project_not_allowed");
    expect(urls).toHaveLength(0);
  });
});

describe("get_release_definition", () => {
  const def = (tasks: unknown[]) => ({
    id: 7,
    name: "Deploy Big Boy - Tabular Model",
    variables: { Plain: { value: "ok" }, Hidden: { value: "topsecret", isSecret: true } },
    environments: [{ id: 1, name: "Staging", deployPhases: [{ workflowTasks: tasks }] }],
  });

  it("masks secret variables and secret-named inputs", async () => {
    const tasks = [{ name: "Run", definitionType: "task", inputs: { Password: "p1", script: "Install.ps1" } }];
    const { ctx } = setup(() => ({ body: def(tasks) }));
    const r = await call(ctx, "get_release_definition", { project: "Modax", id: 7 });
    expect(r.text).not.toContain("topsecret");
    expect(r.text).not.toContain("p1\"");
    expect(r.json.data.variables.Plain.value).toBe("ok");
    expect(r.json.data.environments[0].deployPhases[0].workflowTasks[0].inputs.script).toBe("Install.ps1");
  });

  it("expands task groups, including nested ones", async () => {
    const { ctx } = setup((url) => {
      if (url.includes("/release/definitions/7")) return { body: def([{ definitionType: "metaTask", taskId: "g1" }]) };
      if (url.includes("/taskgroups/g1")) return { body: { value: [group("g1", [metaRef("g2")])] } };
      if (url.includes("/taskgroups/g2")) return { body: { value: [group("g2", [{ task: { id: "t" }, inputs: {} }])] } };
      return { status: 404 };
    });
    const r = await call(ctx, "get_release_definition", { project: "Modax", id: 7 });
    const g = r.json.data.environments[0].deployPhases[0].workflowTasks[0].expandedTaskGroup;
    expect(g.name).toBe("G-g1");
    expect(g.tasks[0].expandedTaskGroup.name).toBe("G-g2");
  });

  it("marks a looping group with cycle: true", async () => {
    const { ctx } = setup((url) => {
      if (url.includes("/release/definitions/7")) return { body: def([{ definitionType: "metaTask", taskId: "g1" }]) };
      if (url.includes("/taskgroups/g1")) return { body: { value: [group("g1", [metaRef("g2")])] } };
      if (url.includes("/taskgroups/g2")) return { body: { value: [group("g2", [metaRef("g1")])] } };
      return { status: 404 };
    });
    const r = await call(ctx, "get_release_definition", { project: "Modax", id: 7 });
    const g1 = r.json.data.environments[0].deployPhases[0].workflowTasks[0].expandedTaskGroup;
    expect(g1.tasks[0].expandedTaskGroup.tasks[0].expandedTaskGroup).toEqual({ id: "g1", cycle: true });
  });

  it("returns {id, error} for an unreadable group and keeps the rest", async () => {
    const { ctx } = setup((url) => {
      if (url.includes("/release/definitions/7")) return { body: def([{ definitionType: "metaTask", taskId: "g1" }]) };
      return { status: 403 };
    });
    const r = await call(ctx, "get_release_definition", { project: "Modax", id: 7 });
    expect(r.isError).toBe(false);
    expect(r.json.data.environments[0].deployPhases[0].workflowTasks[0].expandedTaskGroup).toEqual({ id: "g1", error: "forbidden" });
    expect(r.json.data.name).toBe("Deploy Big Boy - Tabular Model");
  });

  it("redacts secrets inside task group inputs", async () => {
    const { ctx } = setup((url) => {
      if (url.includes("/release/definitions/7")) return { body: def([{ definitionType: "metaTask", taskId: "g1" }]) };
      return { body: { value: [group("g1", [{ task: { id: "t" }, inputs: { Password: "grouppw", args: "x Pwd=hidden1;" } }])] } };
    });
    const r = await call(ctx, "get_release_definition", { project: "Modax", id: 7 });
    expect(r.text).not.toContain("grouppw");
    expect(r.text).not.toContain("hidden1");
  });

  it("caps output at 200 KB and sets truncated", async () => {
    const big = def([{ definitionType: "task", inputs: { script: "x".repeat(300_000) } }]);
    const { ctx } = setup(() => ({ body: big }));
    const r = await call(ctx, "get_release_definition", { project: "Modax", id: 7 });
    expect(r.json.truncated).toBe(true);
    expect(r.json.fullSize).toBeGreaterThan(200 * 1024);
    expect(r.text.length).toBeLessThan(400 * 1024);
  });

  it("rejects a non-positive id", async () => {
    const { ctx, urls } = setup(() => ({}));
    const client = await connect(ctx);
    const res: any = await client.callTool({ name: "get_release_definition", arguments: { project: "Modax", id: 0 } });
    expect(res.isError).toBe(true);
    expect(urls).toHaveLength(0);
  });
});

describe("errors and the PAT", () => {
  it("a bad PAT returns 'PAT rejected or expired' and the token is in neither output nor audit log", async () => {
    const { ctx, auditPath } = setup(() => ({ status: 401 }));
    const r = await call(ctx, "list_release_definitions", { project: "Modax" });
    expect(r.isError).toBe(true);
    expect(r.json.message).toBe("PAT rejected or expired");
    const audit = readFileSync(auditPath, "utf8");
    expect(r.text).not.toContain(PAT);
    expect(audit).not.toContain(PAT);
    expect(audit).not.toContain(Buffer.from(":" + PAT).toString("base64"));
    expect(JSON.parse(audit.trim()).outcome).toBe("auth_failed");
  });

  it("treats a 200 sign-in page as a rejected PAT", async () => {
    const { ctx } = setup(() => ({ type: "text/html" }));
    const r = await call(ctx, "list_release_definitions", { project: "Modax" });
    expect(r.json.error).toBe("auth_failed");
  });

  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const { ctx, urls } = setup(() => (++n < 3 ? { status: 429, headers: { "retry-after": "1" } } : { body: { value: [] } }));
    const r = await call(ctx, "list_release_definitions", { project: "Modax" });
    expect(r.isError).toBe(false);
    expect(urls).toHaveLength(3);
  });

  it("audit lines carry allowed fields only", async () => {
    const { ctx, auditPath } = setup(() => ({ body: { value: [] } }));
    await call(ctx, "list_release_definitions", { project: "Modax" });
    const line = JSON.parse(readFileSync(auditPath, "utf8").trim());
    expect(Object.keys(line).sort()).toEqual(["args", "duration_ms", "http", "key", "outcome", "tool", "truncated", "ts"]);
    expect(line.key).toBe("read");
    expect(line.http).toEqual([200]);
  });
});
