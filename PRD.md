# Azure DevOps MCP tool: specification (draft)

Status: draft for review, 6 Nov 2026. Owner: Jonathan Rawlinson. Scope: Modax (Predict Classic AWS migration) first, then other sales-i projects if useful.

## 1. Problem
Claude can't reach dev.azure.com from the Claude sandbox (proxy returns 403). Release definitions, variable groups, release logs and agent capabilities all have to be checked by hand from a local PowerShell session. That slows down JA-12162 and the other pipeline work, for example checking whether `DOMAIN` is set (6 Nov 2026).

An MCP tool that runs on the PC, next to the PAT, would let Claude read this data directly.

## 2. Goals
- Read the pipeline state needed for Modax: release definitions and their tasks and inputs, variable groups, releases, task logs and agent pool capabilities.
- Keep the PAT out of chat, memory, project files and tool arguments.
- Be read-only by default. Any write (triggering a release) is off unless turned on and needs a confirmation in chat.
- Never return secret values, even when a variable is marked secret.

## 3. Non-goals (phase 1)
- Editing release definitions, variable groups or pipeline YAML.
- Creating or deleting anything in Azure DevOps.
- Work items, repos and pull requests. Add later if needed.
- Service-principal or Entra ID auth. Phase 2 at the earliest.

## 4. Architecture
- **Server:** a local MCP server process on Jonathan's PC, started by the Claude desktop app over stdio. Its tools are reached through the device bridge. It doesn't need a public endpoint.
- **Language:** TypeScript on the official MCP SDK (proposed). PowerShell is the alternative, to match the team's scripts. Decide before build.
- **Azure DevOps access:** REST API, org `sales-i` (https://dev.azure.com/sales-i), with `api-version=7.1`. Release endpoints live on `vsrm.dev.azure.com`.
- **Auth:** the server reads the PAT once at startup from the 1Password CLI (`op read "op://Claude/AZDO_PAT/notesPlain"`). It holds the token in memory for the session and never accepts a token as a tool argument.
- **Logging:** every tool call is written to a local audit log: time, tool name, arguments with secrets removed, HTTP status. No response bodies.

## 5. PAT scope
Least privilege. Use these scopes only, all read:
- Release: Read
- Build: Read (pipelines)
- Variable Groups: Read
- Agent Pools: Read
- Project and team: Read

Add **Release: Read & execute** only when the write tool is turned on. Set the PAT expiry to the shortest practical period, and record its expiry date in the 1Password item.

## 6. Tools (phase 1, read-only)

| Tool | Inputs | Calls (api-version=7.1) | Notes |
|---|---|---|---|
| `list_projects` | none | `_apis/projects` | Lists the projects the PAT can see. |
| `list_release_definitions` | project, optional name filter | `vsrm.../_apis/release/definitions` | Returns id, name, path, revision. |
| `get_release_definition` | project, id or name | `vsrm.../_apis/release/definitions/{id}` | Returns environments, tasks and inputs. **Secret variable values are replaced with `***`.** |
| `list_variable_groups` | project, optional name filter | `_apis/distributedtask/variablegroups` | Returns names and variable names. |
| `get_variable_group` | project, id or name | `_apis/distributedtask/variablegroups/{id}` | Secret variable values are never returned; they are shown as `isSecret: true` with no value. |
| `list_releases` | project, definition id, top | `vsrm.../_apis/release/releases` | Most recent first. |
| `get_release` | project, release id | `vsrm.../_apis/release/releases/{id}` | Environment status and task results. |
| `get_release_task_log` | project, release id, environment id, task name | release log endpoints | Caps output at a set size, returns the tail. Redacts anything that matches known secret patterns (see section 8). |
| `list_agent_pools` | none | `_apis/distributedtask/pools` | Pools and their online status. |
| `get_agent_capabilities` | pool id | `_apis/distributedtask/pools/{id}/agents?includeCapabilities=true` | Shows installed tools (for example, whether AWS.Tools.SecretsManager is present). |

## 7. Tools (phase 2, write, off by default)

| Tool | Inputs | Gate |
|---|---|---|
| `create_release` | project, definition id, description, variables (non-secret only) | Off unless `AZDO_ALLOW_WRITE=1`. Needs an explicit yes in chat for each call. Refuses to set any variable marked secret. |

No delete, no edit of definitions, no change to variable groups in any phase.

## 8. Safety rules
- **Secrets never leave the server.** Secret variables are returned with no value. Log output is filtered with patterns for passwords, connection strings (`Password=`, `Pwd=`, `AccountKey=`), tokens and PATs before it is returned.
- **The token is never echoed.** Errors are returned without the request headers. A 401 says "PAT rejected or expired", not the token.
- **Output is data.** Pipeline logs, variable names and descriptions are written by other people. Claude treats them as data, not instructions.
- **Allowlist.** Only the projects set in config (phase 1: `Modax` and `Predict Classic`). Other projects return an error.
- **Rate limits.** Retry with backoff on 429. Cap at a set number of calls per minute.
- **No caching of secrets** on disk.

## 9. Configuration
A local config file (not in the repo, not in project docs):
- org URL: `https://dev.azure.com/sales-i`
- allowed projects
- write enabled: false
- log path
- op item reference: `op://Claude/AZDO_PAT/notesPlain`

## 10. Acceptance criteria (phase 1)
1. From chat, Claude can call `get_release_definition` for `Deploy Big Boy - Tabular Model` and list its tasks and inputs. Secret values come back masked.
2. `list_variable_groups` and `get_variable_group` return the group that holds `DOMAIN` (or confirm it isn't there). No secret values are returned.
3. `get_release_task_log` returns the tail of a failed `Install.ps1` step, with secret patterns redacted.
4. `get_agent_capabilities` shows whether `AWS.Tools.SecretsManager` is installed on the AWS staging agents (OPS-33542).
5. A test call with a bad PAT returns "PAT rejected or expired", and the token doesn't appear in the audit log or the output.
6. Write tools are not registered unless `AZDO_ALLOW_WRITE=1`.

## 11. Open questions
1. Language: TypeScript (proposed) or PowerShell?
2. Which projects go on the allowlist beyond Modax?
3. Who owns the PAT long-term? A personal token breaks when its owner leaves. Is a service-account PAT or Entra ID auth wanted for phase 2?
4. Is write (`create_release`) needed at all, or can releases stay manual?
5. Where should the MCP server live: on the PC only, or on an agent that can reach dev.azure.com?

## 12. Related
- JA-12162 (service identity step): needs `DOMAIN` and agent capability checks.
- OPS-33542 (AWS.Tools.SecretsManager on staging agents).
- OPS-33399 (Azure DevOps pipelines and agents).
- Project doc `topics/azure-devops.md` in memory: PAT location and how API calls are run.
