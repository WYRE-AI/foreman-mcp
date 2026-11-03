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
| `FOREMAN_BASE_URL` | No | Foreman API base URL. Defaults to `https://foreman.example.com`. |
| `FOREMAN_USERNAME` | For stdio and `AUTH_MODE=env` | Foreman username. |
| `FOREMAN_TOKEN` | For stdio and `AUTH_MODE=env` | Foreman Personal Access Token. |
| `FOREMAN_CA_CERT_FILE` | No | Optional CA certificate for self-signed installs. |
| `AUTH_MODE` | No | `env` or `gateway`. Defaults to `env`. |
| `MCP_TRANSPORT` | No | `stdio` or `http`. Defaults to `stdio`. |
| `MCP_HTTP_HOST` | No | HTTP bind host. Defaults to `127.0.0.1`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `MCP_ALLOW_INSECURE_DEV` | No | Local-only HTTP development bypass. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Gateway service-to-service secret. |
| `FOREMAN_TOOL_TIERS` | No | Comma-separated `read`, `write`, or `admin`. Defaults to `read`. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error`. |

## Authentication

The server uses HTTP Basic authentication with `FOREMAN_USERNAME` and `FOREMAN_TOKEN`. The token should be a Foreman Personal Access Token, not the account password.

In gateway mode, credentials are read from the `X-Foreman-Username` and `X-Foreman-Token` headers. The service-to-service secret is required and verified with `CONDUIT_S2S_SECRET`.

The optional `FOREMAN_CA_CERT_FILE` adds a custom CA for self-signed installs. TLS verification cannot be disabled.

## Tool Tiers

- `read` is the default tier.
- `write` tools can create, update, or act on real infrastructure.
- `admin` tools carry destructive-action warnings and are high impact.

Tools outside the enabled tiers are neither listed nor callable.

## Tools

The server currently exposes 72 Foreman REST endpoints as MCP tools: 47 read, 18 write, and 7 admin. Tool names use the `foreman_<area>_<action>` convention, such as `foreman_hosts_list`, `foreman_host_get`, `foreman_host_power`, and `foreman_hosts_bulk_build`.

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
