# Feature 1: release definitions and the core they need

Status: approved 6 Nov 2026. Parent: SPEC.md (sections 2 to 7).

## Outcome
Claude can list release definitions by id and name, and pull one full definition by id with its task groups expanded. Secrets never come back.

## Tools

### `list_release_definitions`
- Input: `project`, optional `name` (case-insensitive contains filter).
- Call: `GET {vsrm}/{project}/_apis/release/definitions?api-version=7.1`.
- Output: `id`, `name`, `path`, `revision` per definition. Cap 200 rows, with `truncated`.

### `get_release_definition`
- Input: `project`, numeric `id`. No name lookup; use the list tool to find the id.
- Call: `GET {vsrm}/{project}/_apis/release/definitions/{id}?api-version=7.1`.
- Output: environments, tasks, inputs and variables, redacted as in SPEC section 4. Cap 200 KB, with `truncated`.

## Task group expansion
- A step with `definitionType: metaTask` references a task group by id.
- For each one, call `GET {project}/_apis/distributedtask/taskgroups/{id}?api-version=7.1`.
- Put the group's name, version, tasks and inputs next to the reference as `expandedTaskGroup`.
- Groups inside groups are expanded too, to a depth of 5. A group already on the current path is not expanded again (loop guard); it is marked `{id, cycle: true}`.
- A group that cannot be read returns `{id, error}` with the SPEC error code. The call does not fail.
- Each group is fetched once per call and reused.
- Task group inputs go through the same redaction rules as the definition.

## Core built in this feature
`config.ts`, read-key `auth.ts`, `azdo-client.ts` (retry, call cap, allowlist, error codes), `redact.ts`, `audit.ts`, the data wrapper, and server registration. Not in this feature: the elevated key, `approval.ts` and `create_release`.

## Read PAT
Needs **Task Groups: Read** as well as the scopes in SPEC section 9. Without it, expansion returns `forbidden` per group.

## Build order
1. Scaffold: TypeScript, vitest, MCP SDK.
2. `config.ts` and `auth.ts`.
3. `azdo-client.ts`.
4. `redact.ts`, `audit.ts`, data wrapper.
5. `list_release_definitions`.
6. `get_release_definition`.
7. Task group expansion.

## Acceptance
1. `list_release_definitions` for `Modax` returns ids and names, including `Deploy Big Boy - Tabular Model`.
2. `get_release_definition` for that id lists its tasks and inputs, with secret variables and secret-named inputs masked.
3. A definition with a task group returns it as `expandedTaskGroup`, with nested groups expanded.
4. A looping group returns `cycle: true`. An unreadable group returns `{id, error}` and the rest of the definition is intact.
5. A bad PAT returns `PAT rejected or expired`; the token is absent from the output and the audit log.
6. A project outside the allowlist returns `project_not_allowed` with no HTTP call.
7. Output over 200 KB is cut with `truncated: true`.
8. Only the read tools are registered.

Live check: run 1 to 3 against the real org, and search the output for secret values.

## Delivery
Branch `feature/release-definitions`, a worktree off `main`, draft PR into `main`.
