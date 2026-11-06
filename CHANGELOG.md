# Changelog

## [Unreleased]

### Security

- HTTP transport: `CONDUIT_S2S_SECRET` must be at least 32 characters and known/pattern placeholders (for example 40 `x` characters) are refused; the secret is never logged.
- HTTP transport: `Host` header allow-list on `/mcp` (`MCP_ALLOWED_HOSTS`, DNS-rebinding protection) and a 1 MiB request body limit (`413`).
- Gateway mode never falls back to environment credentials: per-request `X-Foreman-Username` / `X-Foreman-Token` headers via `AsyncLocalStorage`; missing headers return `401` and tool calls without scoped credentials return an error.
- `FOREMAN_BASE_URL` is required (no default). Any https host is accepted (previously only `foreman.example.com`); http only for localhost. HTTP mode exits at startup when it is unset; stdio mode starts and every tool call returns an error.
- Path parameters are validated (empty, `.`, `..`, `/`, `\`, control characters rejected) and encoded by one `buildPath` that substitutes every `:placeholder` on the raw template.
- Only declared arguments are accepted; path params are never repeated in the query or body; `__proto__`/`constructor` are dropped.
- Error text is redacted (token, Basic auth value, derived forms) before truncation to 2000 characters; successful responses are redacted too. A 401/403 is never retried.
- `FOREMAN_CA_CERT_FILE` now uses an undici agent cached per CA path.
- Docker image pinned to `node:22-alpine@sha256:...`; added `.dockerignore`; CI workflow permissions pinned.

### Changed

- Tiers: `foreman_hosts_bulk_build` and `foreman_hosts_bulk_change_owner` moved from write to admin; `foreman_hosts_create`, `foreman_host_update` and `foreman_hostgroup_update` also moved to admin (47 read / 13 write / 12 admin). Every write and admin tool now reports `destructiveHint: true`. `foreman_setting_update` and `foreman_host_status_delete` are described as HIGH-IMPACT rather than IRREVERSIBLE.

### Fixed

- List and `GET` arguments (`search`, `page`, `per_page`, ...) are now sent as the query string; they were dropped before.
- Schemas now match Foreman: `foreman_host_boot` takes `device`; `foreman_host_disassociate` takes no body; `foreman_host_rebuild_config` takes an optional `only`; `foreman_hostgroups_clone` takes `name`; bulk tools take `included` / `excluded`; report generate/schedule take their parameters at the top level; settings are addressed by name; `foreman_hosts_bulk_delete` sends its body.

## [0.1.0] - 2026-11-03

### Added

- Initial Foreman MCP server with 72 tiered REST tools.
