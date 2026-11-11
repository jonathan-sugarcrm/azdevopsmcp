import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import type { Ctx } from "../src/tools/run.js";

async function connect(getCtx: () => Promise<Ctx>) {
  const server = buildServer(getCtx);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("startup", () => {
  it("handshake and tool listing complete without reading the PAT", async () => {
    let reads = 0;
    const client = await connect(() => {
      reads++;
      return new Promise<Ctx>(() => {}); // a PAT read that never finishes
    });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["get_release_definition", "list_release_definitions"]);
    expect(reads).toBe(0);
  });

  it("a failed PAT read is returned as a tool error", async () => {
    const client = await connect(() => Promise.reject(new Error("Could not read the PAT with the 1Password CLI")));
    const res = await client.callTool({ name: "list_release_definitions", arguments: { project: "Orion" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("Could not read the PAT with the 1Password CLI");
  });
});
