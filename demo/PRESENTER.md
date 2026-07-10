# MCP Traffic Control in NGINX — what the demo shows

## The idea

NGINX sits between MCP clients and servers as a reverse proxy. A small
JavaScript module (njs) **reads the MCP protocol in flight** — tool names,
client identities, server identities, error results — and uses it to make
traffic decisions **every second**, with no changes to any client or server.

## The three building blocks (the "components")

| Component | What it measures | What it does |
|---|---|---|
| **Client fairness loop** | Each client's tool-calls/sec (smoothed) | Caps every client at **1.25x the average** client rate — heavy users get HTTP 429, light users are never touched. The cap is recomputed every second from live traffic, not configured by hand. |
| **Upstream protection loop** | Each backend's tool **error ratio**, parsed from JSON-RPC responses | When errors exceed **5%**, the backend's allowed rate is **halved** in steps; when healthy, it recovers **+5 rps/s**. Same principle as TCP congestion control (AIMD). |
| **Health-based routing** | Same error ratio | **New sessions** are steered away from an unhealthy backend to the healthiest one. Existing sessions stay pinned (MCP sessions are server-bound). With no traffic the error estimate decays, so probe sessions eventually return — a half-open circuit breaker. |

## The four policies (rotate automatically every 2 minutes)

1. **open** — everything off. Baseline: watch natural traffic, including
   ~25% tool errors on the flaky backend.
2. **protect-upstreams** — protection loop only. Watch the flaky backend's
   limit staircase down and 429s appear.
3. **fair-clients** — fairness loop only. Watch the heaviest client
   (purple) get clipped at the shared cap.
4. **full-control** — all three combined. Watch sessions reroute away from
   the flaky backend and its error impact on clients collapse.

Purple markers on all dashboard panels mark each policy switch and explain
what changed. Policies can also be pinned live:

```bash
curl -X POST 'http://localhost:9100/policy?policy=full-control&auto=off'
```

## The key message

**These four policies are just examples.** The entire control plane is
~400 lines of JavaScript ([`nginx/mcp_control.js`](nginx/mcp_control.js))
running inside NGINX — the thresholds, the fairness formula, the AIMD
constants, the routing rule, even the policy list itself are plain code.
Anything you can compute from the traffic you can turn into policy:
per-tool limits, tenant quotas, cost budgets, schedule-based rules, canary
routing. If you can express it in JavaScript, NGINX can enforce it on MCP
traffic in real time.

## Performance (measured on this demo)

The control plane costs roughly **0.2ms of worker CPU per request**: the
proxy sustains thousands of controlled tool calls per second **per core**
(~7,500 req/s on 8 shared cores vs. ~14,700 req/s for a plain proxy path —
see the [README performance section](README.md#performance-overhead-of-the-control-plane)
for the method and numbers). Real MCP traffic is LLM-paced — tens to
hundreds of tool calls per second — so the ceiling is orders of magnitude
away. Config details matter more than the JavaScript: upstream `keepalive`
pools alone were an 11x throughput difference.

## What NGINX Plus would add (OSS vs. commercial)

NGINX Plus shares the same core engine — plain proxying speed is identical.
The gains from a Plus rewrite are architectural:

| Demo component (njs today) | NGINX Plus native equivalent |
|---|---|
| Rate check in the njs gate | `limit_req` with dynamic `rate=$variable` from the key-value store (C-speed, REST-updatable) |
| Session→upstream affinity (shared dict) | `sticky learn` keyed on `Mcp-Session-Id` |
| Error-based rerouting | Active health checks + dynamic upstream API |
| Policy control API (`:9100/policy`) | The supported NGINX Plus REST API + live dashboard |
| **MCP parsing** (tool names, error status from JSON-RPC/SSE) | **No native equivalent — njs remains the MCP-awareness layer on Plus too** |

Expected effect of moving enforcement into C: **~1.3–1.5x** controlled-path
throughput keeping full per-tool observability (up to ~2x if limiting is
header-only), and rejections become nearly free — `limit_req` fires before
the request body is even read. The strongest Plus argument at realistic MCP
rates isn't throughput though: **`zone_sync` replicates limits and session
affinity across a cluster**, while the OSS shared dicts are per-instance
and reset on restart.

**Pitch line:** OSS + njs proves the concept at thousands of controlled
calls/sec per core; Plus turns it into a productizable architecture —
native enforcement, a supported control-plane API, and cluster-wide state —
while njs remains the MCP-awareness layer in both.

## Where to look during the demo

- **MCP traffic control** dashboard (Grafana, http://localhost:3000,
  admin/admin) — the control plane: policy timeline, live "what you are
  seeing" narration, limits vs. observed rates, 429s, reroutes, and a
  phase-by-phase presenter script at the bottom.
- **MCP overview** dashboard — the passive observability view: per-tool /
  per-client / per-server latency, RPS, and error rates, with demonstrator
  notes describing how each policy phase manifests there.
