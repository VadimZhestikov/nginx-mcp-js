# Agentic Observability Demo

A Docker Compose demo of the MCP observability setup described in the
[root README](../README.md). Uses standard containers from DockerHub for all
components, with a pre-provisioned Grafana dashboard showing live per-tool
metrics within minutes.

## Architecture

```mermaid
flowchart TB
    Client[MCP Client<br><i>client-red / green / blue / purple</i>]
    Client -->|MCP| NGINX[NGINX :9000<br><i>njs + nginx-otel</i>]
    NGINX -->|/mcp-stable| S1[mcp-stable :9001]
    NGINX -->|/mcp-flaky| S2[mcp-flaky :9002]
    NGINX -->|/mcp-sluggish| S3[mcp-sluggish :9003]
    NGINX -->|traces<br>gRPC :4317| OTel[OTel Collector<br><i>spanmetrics</i>]
    OTel -->|metrics :9464| Prom[Prometheus :9090]
    Prom --> Grafana[Grafana :3000<br><i>MCP overview dashboard</i>]
```

## Components

| Component | Role | Source |
|-----------|------|--------|
| [NGINX](https://github.com/nginx/nginx) | Reverse proxy between MCP client and server | `nginx:alpine-otel` from DockerHub |
| [njs](https://github.com/nginx/njs) | JavaScript module that parses SSE/JSON-RPC responses to extract tool names and error status | Pre-installed in NGINX image |
| [nginx-otel](https://github.com/nginxinc/nginx-otel) | NGINX dynamic module that exports OpenTelemetry traces with custom span attributes | Pre-installed in NGINX image |
| [OTel Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) | Receives traces, converts spans to metrics via the spanmetrics connector, exposes a Prometheus endpoint | `otel/opentelemetry-collector-contrib` from DockerHub |
| [Prometheus](https://github.com/prometheus/prometheus) | Scrapes span-derived metrics from the OTel Collector | `prom/prometheus` from DockerHub |
| [Grafana](https://github.com/grafana/grafana) | Visualizes metrics in a pre-provisioned dashboard | `grafana/grafana-oss` from DockerHub |
| MCP Server (Go) | Mock [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) server with 8 tools and configurable error/latency injection; three instances run with different profiles (stable, flaky, sluggish) | Built from `mcp/mcp_server.go` |
| MCP Client (Go) | Traffic generator with four client identities (red, green, blue, purple) in a 1:2:3:1 weight distribution, each targeting a different server; automatically retries on connection failure | Built from `mcp/mcp_client.go` |

Both Go programs use the official
[MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk).

### Server profiles

| Server | Port | Behavior |
|--------|------|----------|
| mcp-stable | 9001 | No errors, base latency (`--max-latency 50ms`) |
| mcp-flaky | 9002 | ~2% protocol errors, ~25% tool errors, base latency |
| mcp-sluggish | 9003 | No errors, elevated latency (`--max-latency 100ms`) |

`query_db` and `resize_image` use 5x and 3x the base `--max-latency`
respectively, so they are noticeably slower on the sluggish server
(up to 500ms and 300ms).

### Client profiles

| Client | Weight | Target |
|--------|--------|--------|
| client-red | 1 | mcp-stable |
| client-green | 2 | mcp-flaky |
| client-blue | 3 | mcp-sluggish |
| client-purple | 1 | mcp-stable |

## Quick start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose
- [Docker Compose](https://docs.docker.com/compose/install/) (v2.0+)

### Run

From the **demo directory**:

```bash
cd demo
docker compose up --build
```

This will:
1. Build the MCP server/client Go binaries
2. Pull standard images from DockerHub (NGINX, OTel Collector, Prometheus, Grafana)
3. Start all 8 services in separate containers
4. Launch the traffic generator with 6 concurrent workers

The MCP client logs show per-client counters (red/green/blue/purple):

```
Requests: (12/25/38/11) | Errors: (0/3/0/0) | RPS: (12/24/37/11)
```

To stop all services:

```bash
docker compose down
```

### View the dashboard

1. **Wait about 30 seconds** after starting the containers.  Prometheus scrapes
   metrics every 5 seconds and the Grafana dashboard queries use `rate()` over
   a 1-minute window, so the panels populate quickly once traffic starts
   flowing.

2. Open **http://localhost:3000** in your browser.

3. Log in with username `admin` and password `admin` (skip the password change
   prompt).

4. Navigate to **Dashboards** and open the **MCP overview** dashboard.

5. The dashboard has nine panels in a 3x3 grid:

   |  | per tool | per client | per server |
   |--|----------|------------|------------|
   | **P99 response time** | by tool name | by client identity | by server identity |
   | **RPS** | by tool name | by client identity | by server identity |
   | **Error rate** | by tool name | by client identity | by server identity |

   `query_db` and `resize_image` have intentionally higher latency (5x and 3x
   the base `--max-latency`).  Errors are concentrated on the flaky server
   (~25% tool error rate).

## Traffic control demo

Beyond passive observability, the demo includes a dynamic traffic-control
plane (`nginx/mcp_control.js`) that recomputes rate limits every second from
the traffic it observes and enforces them in NGINX — no changes to MCP
clients or servers:

Only `tools/call` requests are measured and limited, so limits read as
**tool calls per second** and session setup is never rejected — the
proxy throttles tool invocations, not the MCP protocol:

- **Client loop** — each client identity's offered tool-call rate is
  measured (EWMA); under a `fair` policy every client is capped at
  1.25x the average active-client rate, so heavy hitters get `429`
  while light clients are never touched.
- **Upstream loop** — each upstream's tool error ratio is tracked from
  the parsed JSON-RPC responses; under an `aimd` policy an unhealthy
  upstream's allowed rate is halved every 3s (down to a floor) and
  recovers additively (+5 rps/s) once healthy — TCP-style congestion
  control for tool calls.
- **Routing** — new sessions destined for an upstream whose error ratio
  exceeds 5% are transparently rerouted to the healthiest upstream
  (`Mcp-Session-Id` affinity keeps existing sessions pinned). With no
  traffic the error estimate decays, letting probe sessions return
  (half-open circuit breaker).

The mock client backs off 300ms on failed calls (including `429`s), as
a well-behaved MCP client would — without backoff, rejected calls
return in sub-millisecond and a client can spin at reject speed.

### Policies

Four named policies exercise the loops; by default they **auto-rotate
every 120 seconds** so the dashboard continuously demonstrates rules
changing and their effect:

| Policy | Client limits | Upstream limits | Rerouting |
|--------|---------------|-----------------|-----------|
| `open` | – | – | – |
| `protect-upstreams` | – | AIMD from error rate | – |
| `fair-clients` | fair share | – | – |
| `full-control` | fair share | AIMD | yes |

### Control API (port 9100)

```bash
curl http://localhost:9100/policy                          # current state snapshot
curl -X POST 'http://localhost:9100/policy?policy=full-control&auto=off'  # pin a policy
curl -X POST 'http://localhost:9100/policy?auto=on&interval=45'           # rotate every 45s
curl http://localhost:9100/metrics                         # Prometheus exposition
```

Prometheus scrapes `:9100/metrics` every 5s, so policy flips, limit
changes, `429` counts, and reroutes appear in Grafana within one scrape
interval.

### Built-in narration for demonstrations

The demo explains itself while it runs:

- **Policy-transition annotations** — at every policy switch (automatic
  or via the API) the controller posts a Grafana annotation, so **both
  dashboards** show a purple vertical marker at the exact transition
  moment; hovering it shows what changed and what to watch for.
- **"What you are seeing" panel** — the traffic-control dashboard has a
  live text panel that always describes the active policy's visible
  effects, plus a **Demo guide** panel with a phase-by-phase presenter
  script (what to say, what to point at).
- **Demonstrator notes on MCP overview** — the observability dashboard
  has a companion notes panel describing how each policy phase
  manifests in the passive per-tool/client/server panels.

Open the **MCP traffic control** dashboard for the control plane: the
active policy timeline, per-client offered tool rate vs. dynamic caps,
per-upstream rate vs. AIMD limits, error-ratio EWMA against the 5%
threshold, rejects by reason, and session reroutes. The original **MCP
overview** dashboard shows the effect on real traffic (e.g.
client-green shifting from mcp-flaky to mcp-stable under
`full-control`).

## File layout

```
demo/
├── docker-compose.yaml                 # Multi-container orchestration
├── nginx/
│   ├── mcp.conf                        # NGINX config (proxy + otel + njs)
│   └── mcp_control.js                  # Dynamic rate limiting + routing (njs)
├── mcp/
│   ├── Dockerfile                      # Builds Go binaries
│   ├── mcp_server.go                   # Mock MCP server (8 tools, 3 instances)
│   ├── mcp_client.go                   # Traffic generator (4 client identities)
│   ├── go.mod
│   └── go.sum
├── otel/
│   └── config.yaml                     # OTel Collector: OTLP -> spanmetrics -> Prometheus
├── prometheus/
│   └── prometheus.yaml                 # Scrape config
└── grafana/
    └── provisioning/
        ├── datasources/
        │   └── prometheus.yaml         # Auto-provisioned datasource
        └── dashboards/
            ├── dashboards.yaml         # Dashboard provisioning config
            ├── mcp-overview.json       # Pre-built dashboard (9 panels)
            └── mcp-traffic-control.json # Policy/limits/reroutes dashboard
```

The njs module itself (`mcp.js`) lives at the repository root.

## Services

The Docker Compose setup runs 8 separate containers:

1. **nginx** - Reverse proxy with OpenTelemetry instrumentation
2. **otel-collector** - Receives traces and converts to metrics
3. **prometheus** - Metrics storage and querying
4. **grafana** - Dashboard visualization
5. **mcp-stable** - MCP server with no errors
6. **mcp-flaky** - MCP server with ~25% tool error rate
7. **mcp-sluggish** - MCP server with elevated latency
8. **mcp-client** - Traffic generator

All services communicate over a shared Docker network (`mcp-network`).
