// Copyright (c) F5, Inc.
//
// This source code is licensed under the Apache License, Version 2.0 license found in the
// LICENSE file in the root directory of this source tree.

// Per-request state lives in nginx variables ($mcp_buf, $mcp_first_msg —
// declared with js_var in nginx.conf) rather than module globals: the njs
// engine gives every request a fresh VM, but the QuickJS engine
// (js_engine qjs) runs all requests in one persistent context, where
// module globals would leak across requests and grow without bound.

function mcp_header_filter(r) {
    delete r.headersOut['Content-Length'];

    var body = JSON.parse(r.requestText || '{}');
    if (body.method === 'initialize') {
        var sessionId = r.headersOut['Mcp-Session-Id'];
        var clientName = body.params
                         && body.params.clientInfo
                         && body.params.clientInfo.name;

        if (sessionId && clientName) {
            ngx.shared.mcp_clients.set(sessionId, clientName);
        }
    } else {
        var sessionId = r.headersIn['Mcp-Session-Id'];
        if (sessionId) {
            var clientName = ngx.shared.mcp_clients.get(sessionId);
            if (clientName) {
                ngx.shared.mcp_clients.set(sessionId, clientName);
            }

            var serverName = ngx.shared.mcp_servers.get(sessionId);
            if (serverName) {
                ngx.shared.mcp_servers.set(sessionId, serverName);
            }
        }
    }
}

function parse_sse_first_json(buffer) {
    var sse_messages = buffer.split(/\n\n/);
    for (var i = 0; i < sse_messages.length; i++) {
        var block = sse_messages[i].trim();
        if (!block) {
            continue;
        }

        var lines = block.split(/\n/);
        for (var j = 0; j < lines.length; j++) {
            var line = lines[j];
            if (line.startsWith("data: ")) {
                try {
                    return JSON.parse(line.substring(6));
                } catch (e) {
                }
            }
        }
    }

    return null;
}

function mcp_response_filter(r, data, flags) {
    r.sendBuffer(data, flags);

    if (r.variables.mcp_first_msg) {
        return;
    }

    var buffer = r.variables.mcp_buf + data;
    r.variables.mcp_buf = buffer;

    var json_obj = parse_sse_first_json(buffer);
    if (!json_obj) {
        return;
    }

    r.variables.mcp_first_msg = JSON.stringify(json_obj);
    r.variables.mcp_buf = '';

    if (json_obj.result && json_obj.result.serverInfo) {
        var sid = r.headersOut['Mcp-Session-Id'];
        var name = json_obj.result.serverInfo.name;
        if (sid && name) {
            ngx.shared.mcp_servers.set(sid, name);
        }
    }

    r.done();
}

function first_message(r) {
    var s = r.variables.mcp_first_msg;
    if (!s) {
        return null;
    }

    try {
        return JSON.parse(s);
    } catch (e) {
        return null;
    }
}

function getPath(r, json_obj, path) {
    if (!json_obj) {
        return undefined;
    }

    var parts = path.split('.');
    var current = json_obj;
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (typeof current !== 'object'
            || current === null
            || !current.hasOwnProperty(part))
        {
            return undefined;
        }

        current = current[part];
    }

    return current;
}

function has_error(r) {
    var msg = first_message(r);
    if (!msg) {
        return false;
    }

    if (getPath(r, msg, "error")) {
        return true;
    }

    if (getPath(r, msg, "result.isError")) {
        return true;
    }

    return false;
}

function mcp_tool_name(r) {
    var body = JSON.parse(r.requestText || '{}');
    var method = body.method;
    if (method == 'tools/call') {
        return body.params.name;
    }

    return '';
}

function mcp_server_name(r) {
    var sessionId = r.headersIn['Mcp-Session-Id'];
    if (sessionId) {
        return ngx.shared.mcp_servers.get(sessionId) || '';
    }

    return '';
}

function mcp_client_name(r) {
    var sessionId = r.headersIn['Mcp-Session-Id'];
    if (sessionId) {
        return ngx.shared.mcp_clients.get(sessionId) || '';
    }

    return '';
}

function mcp_tool_status(r) {
    if (has_error(r)) {
        return 'error';
    }

    return 'ok';
}

function mcp_message_parsed(r) {
    return !!r.variables.mcp_first_msg;
}

export default {
    mcp_response_filter, mcp_header_filter,
    mcp_tool_name, mcp_tool_status,
    mcp_client_name, mcp_server_name,
    mcp_message_parsed
};
