# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A proof-of-concept [njs](https://nginx.org/en/docs/njs/) module (`mcp.js` at the repo root) that lets NGINX, acting as a reverse proxy, extract Model Context Protocol (MCP) metadata from JSON-RPC/SSE traffic and expose it as NGINX variables. Combined with nginx-otel, those variables become OpenTelemetry span attributes (`mcp.tool.name`, `mcp.tool.status`, `mcp.client.name`, `mcp.server.name`) — per-tool observability with no changes to MCP clients or servers.

## Commands

There is no build, lint, or test tooling in this repo. The only way to exercise the code end-to-end is the demo:

```bash
cd demo
docker compose up --build   # starts 8 containers: nginx, otel-collector, prometheus, grafana, 3 mock MCP servers, traffic generator
docker compose down
```

- Grafana dashboard: http://localhost:3000 (admin/admin), "MCP overview" dashboard; panels populate ~30s after startup.
- Prometheus: http://localhost:9090. NGINX proxy: localhost:9000.
- The nginx container mounts `../mcp.js` directly, so edits to `mcp.js` only need a container restart (not a rebuild) to take effect.
- NGINX error log is at `info` level in the demo config; use `docker compose logs nginx` when debugging the njs code.

## Architecture

Traffic path: MCP client → NGINX (`mcp.js` body/header filters + nginx-otel) → MCP server. Traces go NGINX → OTel Collector (gRPC :4317, spanmetrics connector) → Prometheus → Grafana.

### mcp.js (the actual product — everything else is demo scaffolding)

**njs, not Node.js.** The file runs inside NGINX's njs engine: no npm, no Node APIs, limited ES6. It uses the njs-specific request object (`r.requestText`, `r.headersIn/Out`, `r.sendBuffer`, `r.done`) and `ngx.shared` dict zones. Keep the existing ES5-style code (`var`, manual property chains) — do not modernize to syntax njs may not support.

**Per-request VM.** The module-level globals `_mcp_buffer` / `_mcp_messages` look like shared mutable state but are safe: njs instantiates a fresh VM per request, so they are effectively per-request buffers.

**How the pieces fit** (wired up in nginx.conf, see `demo/nginx/mcp.conf` or the root README):

1. `mcp_header_filter` (`js_header_filter`) — deletes `Content-Length` (body filter changes buffering), and on `initialize` requests stores `clientInfo.name` keyed by the `Mcp-Session-Id` response header into the `mcp_clients` shared dict. On other requests it re-`set`s existing entries to refresh their eviction timeout.
2. `mcp_response_filter` (`js_body_filter`) — passes chunks through while accumulating them, parses the **first** JSON-RPC message out of the SSE stream (`data: ` lines), stores `serverInfo.name` into the `mcp_servers` shared dict on `initialize` responses, then calls `r.done()` to stop filtering.
3. `mcp_tool_name` / `mcp_tool_status` / `mcp_client_name` / `mcp_server_name` (`js_set`) — evaluated lazily when nginx-otel reads the span-attribute variables at log phase; tool name comes from the request body (`tools/call`), status from the buffered first response message (JSON-RPC `error` or `result.isError`), identities from the shared dicts.

Session-to-identity mapping depends on the two `js_shared_dict_zone` zones (`mcp_clients`, `mcp_servers`) declared in nginx.conf — the module breaks without them.

### demo/

Docker Compose demo: three instances of a mock Go MCP server (`demo/mcp/mcp_server.go`, official MCP Go SDK) with different failure profiles — stable, flaky (~2% protocol / ~10% tool errors), sluggish (elevated latency) — plus a Go traffic generator (`mcp_client.go`) cycling four client identities. `demo/otel/config.yaml` converts spans to metrics via the spanmetrics connector; Grafana dashboards are provisioned from `demo/grafana/provisioning/dashboards/`. Renaming a span attribute in `mcp.js`/nginx.conf requires matching updates in the OTel spanmetrics dimensions and the Grafana dashboard queries.

### demo/nginx/mcp_control.js (dynamic traffic control)

A second njs module that imports `mcp.js` and wraps its filters (`js_body_filter`/`js_header_filter` allow only one handler per location, hence wrapping, and `mcp.js` exports `mcp_message_parsed` as the hook). It implements two per-second control loops driven by a `js_periodic` tick: fair-share per-client rate caps from observed RPS, and AIMD per-upstream limits from tool error-rate EWMAs, plus error-based rerouting of new sessions (session affinity via the `mcp_routes` dict; MCP sessions are server-bound so only `initialize` requests may be steered). Requests enter through a `js_content` gate (`mcp_gate`) that enforces both limits and `internalRedirect`s to internal `/route/<upstream>` locations. State lives in four shared dict zones: `mcp_stats`/`mcp_gauges` (type=number: counters/controller outputs) and `mcp_policy`/`mcp_routes` (strings). Port 9100 serves `/policy` (GET state, POST `?policy=|auto=|interval=` to change; policies auto-rotate by default) and `/metrics` (Prometheus text format, scraped every 5s). Windows in `mcp_stats` are reset via negative `incr`, never `set`, to avoid clobbering concurrent increments.

## Contributing conventions

- F5 CLA required before PRs can merge (a bot prompts on the PR).
- Conventional Commits format preferred; imperative, present-tense subject ≤72 chars; squash/rebase to a clean history before submitting.
