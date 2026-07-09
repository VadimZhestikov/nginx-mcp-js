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

## Where to look during the demo

- **MCP traffic control** dashboard (Grafana, http://localhost:3000,
  admin/admin) — the control plane: policy timeline, live "what you are
  seeing" narration, limits vs. observed rates, 429s, reroutes, and a
  phase-by-phase presenter script at the bottom.
- **MCP overview** dashboard — the passive observability view: per-tool /
  per-client / per-server latency, RPS, and error rates, with demonstrator
  notes describing how each policy phase manifests there.
