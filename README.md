# Foreman MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

An independent [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the documented Foreman REST API as MCP tools.

## Installation

```bash
npm install @foreman/mcp
```

## Configuration

Copy [`.env.example`](.env.example) and set:

| Variable | Required | Description |
|---|---|---|
| `FOREMAN_BASE_URL` | **Yes** | Base URL of your Foreman server, e.g. `https://foreman.example.com`. There is no default. See [Base URL rules](#base-url-rules). |
| `FOREMAN_USERNAME` | For stdio and `AUTH_MODE=env` | Foreman username. |
| `FOREMAN_TOKEN` | For stdio and `AUTH_MODE=env` | Foreman Personal Access Token. |
| `FOREMAN_CA_CERT_FILE` | No | PEM CA bundle for a server with a private or self-signed CA. TLS verification cannot be disabled. |
| `AUTH_MODE` | No | `env` or `gateway`. Defaults to `env`. |
| `MCP_TRANSPORT` | No | `stdio` or `http`. Defaults to `stdio`. |
| `MCP_HTTP_HOST` | No | HTTP bind host. Defaults to `127.0.0.1`. |
| `MCP_HTTP_PORT` | No | HTTP port (1-65535). Defaults to `8080`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Gateway service-to-service secret: at least 32 characters (`openssl rand -hex 32`). Known placeholders (`changeme`, `xxxxxxxx...`, `your-secret...`, `replace-with...`) are refused. |
| `MCP_ALLOWED_HOSTS` | No | Extra `Host` header values accepted on `/mcp`. See [Host check](#host-check-dns-rebinding-protection). |
| `MCP_ALLOW_INSECURE_DEV` | No | `1` allows an empty `CONDUIT_S2S_SECRET` for local development only; the server then binds `127.0.0.1` and does not check `X-Gateway-S2S`. A short or placeholder secret is still refused. |
| `FOREMAN_TOOL_TIERS` | No | Comma-separated `read`, `write`, or `admin`. Defaults to `read`. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error`. |

### Base URL rules

`FOREMAN_BASE_URL` is required.

- In **http** transport mode the server exits with status 1 at startup (`FOREMAN_BASE_URL is required`) when it is unset or invalid.
- In **stdio** mode the server still starts and lists its tools, but every tool call returns an error with that message until the variable is set. A set-but-invalid value fails startup.
- Any `https` host is accepted. The URL is chosen by the operator (never by a request), so private IPs, internal hostnames and non-default ports are fine. `http` is accepted only for `localhost` / `127.0.0.1`.
- Userinfo (`user:pass@`), query strings and fragments are rejected. A path prefix (for example `https://host/foreman`) is kept; trailing slashes are removed.

## Authentication

The server uses HTTP Basic authentication with a username and a Foreman Personal Access Token (not the account password). Foreman has no session or ticket exchange, so there is no credential cache and no re-authentication: a `401`/`403` is reported once and never retried.

**Gateway mode** (`AUTH_MODE=gateway`, HTTP transport) takes the credentials of each request from these headers:

| Header | Description |
|---|---|
| `X-Foreman-Username` | Foreman username (must not contain `:`). |
| `X-Foreman-Token` | Foreman Personal Access Token. |

A request missing either header gets `401`. Gateway mode never falls back to `FOREMAN_USERNAME` / `FOREMAN_TOKEN`; a tool call with no per-request credentials returns an error. The Foreman base URL still comes from `FOREMAN_BASE_URL`.

Every `/mcp` request must carry a valid `X-Gateway-S2S` header signed with `CONDUIT_S2S_SECRET`. The secret is never logged.

### Host check (DNS-rebinding protection)

`/mcp` checks the request `Host` header (port ignored) before anything else. `localhost`, `127.0.0.1` and `[::1]` are always allowed; add the names the gateway uses to reach the container with `MCP_ALLOWED_HOSTS`:

```bash
MCP_ALLOWED_HOSTS=mcp.example.com,foreman-mcp
```

Entries must be bare host names (no port; IPv6 in brackets): an entry containing a port or an unbracketed IPv6 address is logged as a warning and never matches. Other hosts get `403`. The check is always on when the server binds loopback or runs without an S2S secret; on a non-loopback bind with a secret it is enabled by setting `MCP_ALLOWED_HOSTS`. `/health` is exempt. Request bodies on `/mcp` are limited to 1 MiB (`413` above that).

## Tool Tiers

Tools outside the enabled tiers are neither listed nor callable.

| Tier | Tools | What it covers |
|---|---|---|
| `read` (default) | 47 | Read-only `GET` endpoints. |
| `write` | 16 | Create/update and operational actions. Power, boot and bulk power tools (`foreman_host_power`, `foreman_host_boot`, `foreman_hosts_bulk_change_power_state`) **affect real machines**. |
| `admin` | 9 | Irreversible actions and access/permission changes. |

The admin tools:

| Tool | Warning | Why admin |
|---|---|---|
| `foreman_host_delete`, `foreman_hosts_bulk_delete` | DESTRUCTIVE — IRREVERSIBLE | Deletes hosts (and can destroy the machine on a compute resource). |
| `foreman_hostgroup_delete`, `foreman_host_interface_delete`, `foreman_config_report_delete` | DESTRUCTIVE — IRREVERSIBLE | Permanent deletion. |
| `foreman_hosts_bulk_build` | DESTRUCTIVE — IRREVERSIBLE | Marks hosts for reprovisioning; the OS reinstall wipes their disks on the next boot. |
| `foreman_hosts_bulk_change_owner` | HIGH-IMPACT | Changes who owns and can manage the hosts. |
| `foreman_setting_update` | HIGH-IMPACT | Settings include authentication and access-control settings. |
| `foreman_host_status_delete` | HIGH-IMPACT | Clears a host sub-status (recomputed on the next report). |

## Tools

The server exposes 72 Foreman REST endpoints as MCP tools: 47 read, 16 write, and 9 admin. Tool names use the `foreman_<area>_<action>` convention, such as `foreman_hosts_list`, `foreman_host_get`, `foreman_host_power`, and `foreman_hosts_bulk_build`.

Every tool declares its inputs in a JSON schema. Arguments that are not declared are rejected and nothing is sent to Foreman. Path parameters (host ids, names, ...) are validated (not empty, not `.` or `..`, no `/` or `\`, no control characters) and percent-encoded. Error text and response data are redacted (tokens, `Authorization` values, password fields) before they are truncated and returned.

## Upstream license

Foreman is licensed under the GNU General Public License v3.0. This MCP server is an independent MIT-licensed client that talks to Foreman only through its documented REST API. No Foreman code is copied or linked, so the GPL does not apply to this project.

## Development

```bash
npm ci
npm run build
npm test
npm run lint
npm run lint:destructive
npm run smoke
```
