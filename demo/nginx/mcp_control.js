// Copyright (c) F5, Inc.
//
// This source code is licensed under the Apache License, Version 2.0 license found in the
// LICENSE file in the root directory of this source tree.
//
// Dynamic traffic control for MCP: per-client and per-upstream rate limits
// recomputed every second from observed traffic, plus error-rate-based
// session routing.  Wraps the observability filters from mcp.js.
//
// Shared dict zones (declared in nginx.conf):
//   mcp_stats  (number) - raw counters: per-tick windows, totals, decisions
//   mcp_gauges (number) - controller outputs: limits, EWMA rates, error ratios
//   mcp_policy (string) - active policy, rotation state
//   mcp_routes (string) - session id -> upstream (routing affinity)

import mcp from 'mcp.js';

var UPSTREAMS = ['mcp-stable', 'mcp-flaky', 'mcp-sluggish'];

var POLICIES = {
    'open': {
        client: 'none', upstream: 'none', reroute: false,
        desc: 'no limits, no rerouting (baseline)',
        explain: 'Baseline: no control. Limit lines disappear, 429s stop. '
            + 'Natural traffic flows; client-green keeps hitting errors '
            + 'on mcp-flaky.'
    },
    'protect-upstreams': {
        client: 'none', upstream: 'aimd', reroute: false,
        desc: 'AIMD per-upstream limit driven by tool error rate',
        explain: 'Upstream protection: AIMD limits appear. mcp-flaky\'s '
            + 'error ratio is above 5%, so its allowed tool-call rate is '
            + 'halved in steps; healthy upstreams stay at the ceiling. '
            + 'Watch upstream_limit 429s squeeze mcp-flaky.'
    },
    'fair-clients': {
        client: 'fair', upstream: 'none', reroute: false,
        desc: 'per-client cap at FAIR_FACTOR x average client tool-call rate',
        explain: 'Client fairness: every client gets the same cap, 1.25x '
            + 'the average tool-call rate. Watch client-purple (the '
            + 'heaviest tool caller) get clipped with client_limit 429s '
            + 'while light clients are untouched.'
    },
    'full-control': {
        client: 'fair', upstream: 'aimd', reroute: true,
        desc: 'both loops + new sessions rerouted away from unhealthy upstreams',
        explain: 'Full control: both loops plus routing. New sessions avoid '
            + 'unhealthy mcp-flaky; reroutes fire and client-green\'s '
            + 'traffic shifts to mcp-stable (see the MCP overview '
            + 'per-server panels), letting mcp-flaky recover.'
    }
};

var ROTATION = ['open', 'protect-upstreams', 'fair-clients', 'full-control'];

// Controller tunables.  Rates and windows count tools/call requests only, so
// limits read as "tool calls per second" and session setup is never rejected.
var ERR_THRESHOLD = 0.05;      // error ratio above which an upstream is unhealthy
var AIMD_MIN = 4;              // tool-rps floor for clamped upstreams
var AIMD_MAX = 200;            // tool-rps ceiling
var AIMD_INCREASE = 5;         // additive increase per tick when healthy
var AIMD_DECREASE = 0.5;       // multiplicative decrease when unhealthy
var AIMD_HOLD_MS = 3000;       // min time between consecutive decreases
var FAIR_FACTOR = 1.25;        // client cap = FAIR_FACTOR * avg active-client rps
var FAIR_MIN = 2;              // tool-rps floor for client caps
var FAIR_MAX = 60;             // sanity ceiling for client caps
var EWMA_ALPHA = 0.3;          // smoothing for rps estimates
var ERR_ALPHA = 0.1;           // slower smoothing for noisy error ratios
var ERR_DECAY = 0.98;          // error-ratio decay per tick with no traffic (half-open)
var DEFAULT_ROTATE_SECS = 120; // policy auto-rotation period

// Grafana annotation target for policy-transition markers
var GRAFANA_URL = 'http://grafana:3000';
var GRAFANA_AUTH = 'Basic YWRtaW46YWRtaW4=';  // admin:admin (demo credentials)

function policy_state() {
    var p = ngx.shared.mcp_policy;
    var name = p.get('policy');
    if (!name || !POLICIES[name]) {
        name = ROTATION[0];
        p.set('policy', name);
        p.set('auto', 'on');
        p.set('interval', String(DEFAULT_ROTATE_SECS));
        p.set('since', String(Date.now()));
        p.set('idx', '0');
    }
    return {
        name: name,
        cfg: POLICIES[name],
        auto: p.get('auto') !== 'off',
        interval: parseInt(p.get('interval') || String(DEFAULT_ROTATE_SECS)),
        since: parseInt(p.get('since') || '0')
    };
}

function default_upstream(uri) {
    var name = uri.split('/')[1] || '';
    return UPSTREAMS.indexOf(name) >= 0 ? name : null;
}

function reject(r, scope, id) {
    r.variables.mcp_rl_decision = scope;
    ngx.shared.mcp_stats.incr('d:' + scope, 1);
    r.headersOut['Retry-After'] = '1';
    r.headersOut['Content-Type'] = 'application/json';
    r.return(429, JSON.stringify({
        jsonrpc: '2.0',
        id: id === undefined ? null : id,
        error: { code: -32000, message: 'rate limited (' + scope + ')' }
    }));
}

// js_content gate in front of every /mcp-* location: enforces both limits,
// picks the upstream, then hands off to the internal /route/* location.
function mcp_gate(r) {
    var st = policy_state();
    var stats = ngx.shared.mcp_stats;
    var gauges = ngx.shared.mcp_gauges;

    var def = default_upstream(r.uri);
    if (!def) {
        r.return(404);
        return;
    }

    var body = {};
    try {
        body = JSON.parse(r.requestText || '{}');
    } catch (e) {
    }

    var isInit = body.method === 'initialize';
    var sid = r.headersIn['Mcp-Session-Id'];

    var client = '';
    if (isInit) {
        client = (body.params
                  && body.params.clientInfo
                  && body.params.clientInfo.name) || '';
    } else if (sid) {
        client = ngx.shared.mcp_clients.get(sid) || '';
    }

    // Routing: existing sessions stick to their upstream; new sessions may be
    // steered away from an unhealthy default when the policy allows it.
    var target = def;
    var decision = 'allowed';
    if (sid) {
        var pinned = ngx.shared.mcp_routes.get(sid);
        if (pinned && UPSTREAMS.indexOf(pinned) >= 0) {
            target = pinned;
        }
    } else if (isInit && st.cfg.reroute) {
        var err = gauges.get('err:u:' + def) || 0;
        if (err > ERR_THRESHOLD) {
            var best = def;
            var bestErr = err;
            for (var i = 0; i < UPSTREAMS.length; i++) {
                var e2 = gauges.get('err:u:' + UPSTREAMS[i]) || 0;
                if (e2 < bestErr) {
                    best = UPSTREAMS[i];
                    bestErr = e2;
                }
            }
            if (best !== def) {
                target = best;
                decision = 'rerouted';
                stats.incr('rr:' + def + ':' + best, 1);
            }
        }
    }

    // Only tools/call requests are measured and limited: limits then read as
    // "tool calls per second" and session setup is never rejected.
    var isTool = body.method === 'tools/call';

    // Client loop: the window counts offered load (including rejects), so the
    // controller sees each client's demand, not just what got through.
    if (isTool && client) {
        var cw = stats.incr('w:c:' + client, 1);
        if (st.cfg.client !== 'none') {
            var cl = gauges.get('lim:c:' + client);
            if (cl !== undefined && cw > cl) {
                reject(r, 'client_limit', body.id);
                return;
            }
        }
    }

    // Upstream loop: counted only for requests that passed the client gate.
    if (isTool) {
        var uw = stats.incr('w:u:' + target, 1);
        if (st.cfg.upstream !== 'none') {
            var ul = gauges.get('lim:u:' + target);
            if (ul !== undefined && uw > ul) {
                reject(r, 'upstream_limit', body.id);
                return;
            }
        }
    }

    if (isTool || decision === 'rerouted') {
        stats.incr('d:' + decision, 1);
    }
    r.variables.mcp_rl_decision = decision;
    r.variables.mcp_upstream = target;
    r.internalRedirect('/route/' + target);
}

// Wraps mcp.js's header filter and records the session -> upstream mapping
// when the initialize response assigns a session id.
function header_filter(r) {
    mcp.mcp_header_filter(r);

    var sid = r.headersOut['Mcp-Session-Id'];
    if (sid && r.variables.mcp_upstream
        && !ngx.shared.mcp_routes.get(sid))
    {
        ngx.shared.mcp_routes.set(sid, r.variables.mcp_upstream);
    }
}

// Wraps mcp.js's body filter and feeds per-upstream response/error counters
// once the first JSON-RPC message of the response has been parsed.
var _accounted = false;

function response_filter(r, data, flags) {
    mcp.mcp_response_filter(r, data, flags);

    if (!_accounted && mcp.mcp_message_parsed()) {
        _accounted = true;
        var up = r.variables.mcp_upstream;
        if (up) {
            ngx.shared.mcp_stats.incr('q:u:' + up, 1);
            if (mcp.mcp_tool_status(r) === 'error') {
                ngx.shared.mcp_stats.incr('e:u:' + up, 1);
            }
        }
    }
}

// Queues a policy-transition marker for Grafana's annotation store; both
// dashboards query the mcp-policy tag, so a vertical line with the
// explanation text appears on every panel at the moment of the switch.
// The marker is queued (not sent inline) and flushed by the periodic tick
// so it survives Grafana being briefly unreachable, e.g. during startup;
// the payload carries its own timestamp, so late delivery still lands the
// marker at the actual transition moment.
function post_annotation(from, to) {
    var text = '▶ ' + to + ' — ' + POLICIES[to].explain
               + (from ? ' (was: ' + from + ')' : '');
    ngx.shared.mcp_policy.set('ann', JSON.stringify({
        time: Date.now(),
        tags: ['mcp-policy', to],
        text: text
    }));
}

function flush_annotation() {
    var p = ngx.shared.mcp_policy;
    var pending = p.get('ann');
    if (!pending) {
        return;
    }
    ngx.fetch(GRAFANA_URL + '/api/annotations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': GRAFANA_AUTH
        },
        body: pending
    }).then(function (res) {
        if (res.status < 300) {
            p.delete('ann');
        } else {
            ngx.log(ngx.WARN, 'policy annotation failed: HTTP ' + res.status);
        }
    }).catch(function (e) {
        ngx.log(ngx.WARN, 'policy annotation failed: ' + e.message);
    });
}

// js_periodic controller: converts window counters into EWMA rates, error
// ratios into AIMD upstream limits, client demand into fair-share caps, and
// rotates the active policy when auto mode is on.
function tick() {
    var stats = ngx.shared.mcp_stats;
    var gauges = ngx.shared.mcp_gauges;
    var p = ngx.shared.mcp_policy;
    var now = Date.now();

    flush_annotation();

    var st = policy_state();
    if (st.auto && st.since && now - st.since >= st.interval * 1000) {
        var idx = (parseInt(p.get('idx') || '0') + 1) % ROTATION.length;
        var prev = st.name;
        p.set('idx', String(idx));
        p.set('policy', ROTATION[idx]);
        p.set('since', String(now));
        st = policy_state();
        post_annotation(prev, st.name);
    }

    var last = parseInt(p.get('tick_ts') || '0');
    p.set('tick_ts', String(now));
    if (!last) {
        // First tick after startup: the windows have been accumulating for
        // an unknown time, so discard them instead of inferring bogus rates.
        stats.keys(1024).forEach(function (k) {
            if (k.startsWith('w:')) {
                stats.incr(k, -(stats.get(k) || 0));
            }
        });
        post_annotation(null, st.name);
        return;
    }
    var dt = (now - last) / 1000;
    if (dt < 0.2) {
        dt = 0.2;
    } else if (dt > 5) {
        dt = 5;
    }

    // --- clients: measure demand, set caps
    var clients = [];
    stats.keys(1024).forEach(function (k) {
        if (k.startsWith('w:c:')) {
            clients.push(k.substring(4));
        }
    });

    var rates = {};
    clients.forEach(function (c) {
        var v = stats.get('w:c:' + c) || 0;
        stats.incr('w:c:' + c, -v);
        var inst = v / dt;
        var prev = gauges.get('rps:c:' + c);
        var ewma = (prev === undefined)
                   ? inst
                   : EWMA_ALPHA * inst + (1 - EWMA_ALPHA) * prev;
        gauges.set('rps:c:' + c, ewma);
        rates[c] = ewma;
    });

    if (st.cfg.client === 'fair') {
        var active = clients.filter(function (c) { return rates[c] > 0.5; });
        var sum = 0;
        active.forEach(function (c) { sum += rates[c]; });
        var cap = active.length
                  ? Math.min(FAIR_MAX,
                             Math.max(FAIR_MIN,
                                      Math.round(FAIR_FACTOR * sum
                                                 / active.length)))
                  : FAIR_MAX;
        clients.forEach(function (c) {
            gauges.set('lim:c:' + c, cap);
        });
    } else {
        clients.forEach(function (c) {
            gauges.delete('lim:c:' + c);
        });
    }

    // --- upstreams: measure rates and error ratios, run AIMD
    UPSTREAMS.forEach(function (u) {
        var v = stats.get('w:u:' + u) || 0;
        stats.incr('w:u:' + u, -v);
        var inst = v / dt;
        var prev = gauges.get('rps:u:' + u);
        gauges.set('rps:u:' + u,
                   (prev === undefined)
                   ? inst
                   : EWMA_ALPHA * inst + (1 - EWMA_ALPHA) * prev);

        var q = stats.get('q:u:' + u) || 0;
        var e = stats.get('e:u:' + u) || 0;
        var dq = q - (gauges.get('pq:u:' + u) || 0);
        var de = e - (gauges.get('pe:u:' + u) || 0);
        gauges.set('pq:u:' + u, q);
        gauges.set('pe:u:' + u, e);

        var errPrev = gauges.get('err:u:' + u) || 0;
        var errNow = (dq > 0)
                     ? ERR_ALPHA * (de / dq) + (1 - ERR_ALPHA) * errPrev
                     : errPrev * ERR_DECAY;  // no traffic: decay toward probing
        gauges.set('err:u:' + u, errNow);

        if (st.cfg.upstream === 'aimd') {
            var lim = gauges.get('lim:u:' + u);
            if (lim === undefined) {
                lim = AIMD_MAX;
            }
            if (errNow > ERR_THRESHOLD) {
                var lastDec = gauges.get('dec:u:' + u) || 0;
                if (now - lastDec >= AIMD_HOLD_MS) {
                    lim = Math.max(AIMD_MIN, Math.floor(lim * AIMD_DECREASE));
                    gauges.set('dec:u:' + u, now);
                }
            } else {
                lim = Math.min(AIMD_MAX, lim + AIMD_INCREASE);
            }
            gauges.set('lim:u:' + u, lim);
        } else {
            gauges.delete('lim:u:' + u);
        }
    });
}

// Prometheus text exposition of controller state, scraped directly by
// Prometheus so policy/limit changes are visible on the next 5s scrape.
function metrics(r) {
    var stats = ngx.shared.mcp_stats;
    var gauges = ngx.shared.mcp_gauges;
    var st = policy_state();

    var fam = {
        mcp_policy_info: { type: 'gauge', lines: [] },
        mcp_policy_auto: { type: 'gauge', lines: [] },
        mcp_policy_id: { type: 'gauge', lines: [] },
        mcp_client_rps: { type: 'gauge', lines: [] },
        mcp_client_limit: { type: 'gauge', lines: [] },
        mcp_upstream_rps: { type: 'gauge', lines: [] },
        mcp_upstream_limit: { type: 'gauge', lines: [] },
        mcp_upstream_error_ratio: { type: 'gauge', lines: [] },
        mcp_upstream_responses_total: { type: 'counter', lines: [] },
        mcp_upstream_errors_total: { type: 'counter', lines: [] },
        mcp_ratelimit_decisions_total: { type: 'counter', lines: [] },
        mcp_rerouted_total: { type: 'counter', lines: [] }
    };

    Object.keys(POLICIES).forEach(function (name) {
        fam.mcp_policy_info.lines.push(
            'mcp_policy_info{policy="' + name + '"} '
            + (name === st.name ? 1 : 0));
    });
    fam.mcp_policy_auto.lines.push('mcp_policy_auto ' + (st.auto ? 1 : 0));
    fam.mcp_policy_id.lines.push(
        'mcp_policy_id ' + ROTATION.indexOf(st.name));

    gauges.keys(1024).forEach(function (k) {
        var v = gauges.get(k);
        if (v === undefined) {
            return;
        }
        var name = k.substring(k.indexOf(':', 4) + 1);
        if (k.startsWith('rps:c:')) {
            fam.mcp_client_rps.lines.push(
                'mcp_client_rps{client="' + name + '"} ' + v.toFixed(2));
        } else if (k.startsWith('lim:c:')) {
            fam.mcp_client_limit.lines.push(
                'mcp_client_limit{client="' + name + '"} ' + v);
        } else if (k.startsWith('rps:u:')) {
            fam.mcp_upstream_rps.lines.push(
                'mcp_upstream_rps{upstream="' + name + '"} ' + v.toFixed(2));
        } else if (k.startsWith('lim:u:')) {
            fam.mcp_upstream_limit.lines.push(
                'mcp_upstream_limit{upstream="' + name + '"} ' + v);
        } else if (k.startsWith('err:u:')) {
            fam.mcp_upstream_error_ratio.lines.push(
                'mcp_upstream_error_ratio{upstream="' + name + '"} '
                + v.toFixed(4));
        }
    });

    stats.keys(1024).forEach(function (k) {
        var v = stats.get(k);
        if (v === undefined) {
            return;
        }
        if (k.startsWith('d:')) {
            fam.mcp_ratelimit_decisions_total.lines.push(
                'mcp_ratelimit_decisions_total{decision="'
                + k.substring(2) + '"} ' + v);
        } else if (k.startsWith('rr:')) {
            var parts = k.split(':');
            fam.mcp_rerouted_total.lines.push(
                'mcp_rerouted_total{from="' + parts[1] + '",to="'
                + parts[2] + '"} ' + v);
        } else if (k.startsWith('q:u:')) {
            fam.mcp_upstream_responses_total.lines.push(
                'mcp_upstream_responses_total{upstream="'
                + k.substring(4) + '"} ' + v);
        } else if (k.startsWith('e:u:')) {
            fam.mcp_upstream_errors_total.lines.push(
                'mcp_upstream_errors_total{upstream="'
                + k.substring(4) + '"} ' + v);
        }
    });

    var out = [];
    Object.keys(fam).forEach(function (name) {
        if (fam[name].lines.length) {
            out.push('# TYPE ' + name + ' ' + fam[name].type);
            out = out.concat(fam[name].lines);
        }
    });

    r.headersOut['Content-Type'] = 'text/plain; version=0.0.4';
    r.return(200, out.join('\n') + '\n');
}

// Policy control API:
//   GET  /policy                          -> current state snapshot
//   POST /policy?policy=<name>            -> switch policy now
//   POST /policy?auto=on|off              -> toggle auto-rotation
//   POST /policy?interval=<seconds>       -> set rotation period
function control(r) {
    var p = ngx.shared.mcp_policy;
    var gauges = ngx.shared.mcp_gauges;

    if (r.method === 'POST' || r.method === 'PUT') {
        var q = r.args;
        if (q.policy) {
            if (!POLICIES[q.policy]) {
                r.headersOut['Content-Type'] = 'application/json';
                r.return(400, JSON.stringify({
                    error: 'unknown policy',
                    policies: Object.keys(POLICIES)
                }) + '\n');
                return;
            }
            var was = p.get('policy');
            p.set('policy', q.policy);
            p.set('since', String(Date.now()));
            var ri = ROTATION.indexOf(q.policy);
            if (ri >= 0) {
                p.set('idx', String(ri));
            }
            if (was !== q.policy) {
                post_annotation(was, q.policy);
            }
        }
        if (q.auto) {
            p.set('auto', q.auto === 'off' ? 'off' : 'on');
        }
        if (q.interval) {
            var iv = parseInt(q.interval);
            if (iv >= 5) {
                p.set('interval', String(iv));
            }
        }
    }

    var st = policy_state();
    var resp = {
        policy: st.name,
        description: st.cfg.desc,
        what_you_are_seeing: st.cfg.explain,
        auto_rotate: st.auto,
        rotate_interval_seconds: st.interval,
        seconds_in_policy: Math.round((Date.now() - st.since) / 1000),
        rotation: ROTATION,
        policies: {},
        clients: {},
        upstreams: {}
    };
    Object.keys(POLICIES).forEach(function (name) {
        resp.policies[name] = POLICIES[name].desc;
    });
    gauges.keys(1024).forEach(function (k) {
        if (k.startsWith('rps:c:')) {
            var c = k.substring(6);
            resp.clients[c] = {
                rps: Number((gauges.get(k) || 0).toFixed(2)),
                limit: gauges.get('lim:c:' + c)
            };
        }
    });
    UPSTREAMS.forEach(function (u) {
        resp.upstreams[u] = {
            rps: Number((gauges.get('rps:u:' + u) || 0).toFixed(2)),
            limit: gauges.get('lim:u:' + u),
            error_ratio: Number((gauges.get('err:u:' + u) || 0).toFixed(4))
        };
    });

    r.headersOut['Content-Type'] = 'application/json';
    r.return(200, JSON.stringify(resp, null, 2) + '\n');
}

export default {
    mcp_gate, header_filter, response_filter,
    tick, metrics, control
};
