import { AzdoError } from "../errors.js";
import { finish, finishSized, requireProject, type Ctx, type Output } from "./run.js";

const API = "api-version=7.1";
const MAX_ROWS = 200;
const MAX_DEPTH = 5;

export async function listReleaseDefinitions(
  ctx: Ctx,
  a: { project: string; name?: string },
): Promise<Output> {
  const project = requireProject(ctx, a.project);
  const url = `${ctx.cfg.vsrmUrl}/${encodeURIComponent(project)}/_apis/release/definitions?${API}`;
  const res = await ctx.client.getJson<{ value?: any[] }>(url);
  let rows = (res.value ?? []).map((d) => ({ id: d.id, name: d.name, path: d.path, revision: d.revision }));
  if (a.name) {
    const q = a.name.toLowerCase();
    rows = rows.filter((r) => String(r.name).toLowerCase().includes(q));
  }
  const total = rows.length;
  const out = finish(rows.slice(0, MAX_ROWS));
  if (total > MAX_ROWS) return { ...out, truncated: true, fullSize: total };
  return out;
}

type Group = Record<string, any>;

async function fetchGroup(ctx: Ctx, project: string, id: string, cache: Map<string, Promise<Group>>): Promise<Group> {
  let p = cache.get(id);
  if (!p) {
    const url = `${ctx.cfg.orgUrl}/${encodeURIComponent(project)}/_apis/distributedtask/taskgroups/${encodeURIComponent(id)}?${API}`;
    p = ctx.client.getJson<any>(url).then((r) => {
      const g = Array.isArray(r?.value) ? r.value[0] : r;
      if (!g) throw new AzdoError("not_found");
      return g as Group;
    });
    cache.set(id, p);
  }
  return p;
}

/** Expand one task group reference, and any groups inside it. Never throws. */
async function expandGroup(
  ctx: Ctx,
  project: string,
  id: string,
  path: string[],
  cache: Map<string, Promise<Group>>,
): Promise<Record<string, unknown>> {
  if (path.includes(id)) return { id, cycle: true };
  if (path.length >= MAX_DEPTH) return { id, error: "depth_limit" };
  let g: Group;
  try {
    g = await fetchGroup(ctx, project, id, cache);
  } catch (e) {
    return { id, error: e instanceof AzdoError ? e.code : "upstream_error" };
  }
  const tasks: any[] = Array.isArray(g.tasks) ? g.tasks : [];
  const expandedTasks = await Promise.all(
    tasks.map(async (t) => {
      const ref = t?.task;
      if (ref?.definitionType === "metaTask" && ref.id) {
        return { ...t, expandedTaskGroup: await expandGroup(ctx, project, String(ref.id), [...path, id], cache) };
      }
      return t;
    }),
  );
  return { id, name: g.name, version: g.version, inputs: g.inputs, tasks: expandedTasks };
}

export async function getReleaseDefinition(ctx: Ctx, a: { project: string; id: number }): Promise<Output> {
  const project = requireProject(ctx, a.project);
  if (!Number.isInteger(a.id) || a.id <= 0) throw new AzdoError("invalid_input", "id must be a positive integer");
  const url = `${ctx.cfg.vsrmUrl}/${encodeURIComponent(project)}/_apis/release/definitions/${a.id}?${API}`;
  const def = await ctx.client.getJson<any>(url);

  const cache = new Map<string, Promise<Group>>();
  const tasks: Array<Promise<void>> = [];
  for (const env of def.environments ?? []) {
    for (const phase of env.deployPhases ?? []) {
      for (const wt of phase.workflowTasks ?? []) {
        if (wt?.definitionType === "metaTask" && wt.taskId) {
          tasks.push(
            expandGroup(ctx, project, String(wt.taskId), [], cache).then((g) => {
              wt.expandedTaskGroup = g;
            }),
          );
        }
      }
    }
  }
  await Promise.all(tasks);
  return finishSized(ctx, "get_release_definition", project, String(a.id), def);
}
