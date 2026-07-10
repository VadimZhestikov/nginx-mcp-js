wrk.method = "POST"
wrk.body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_stock_price","arguments":{"symbol":"MSFT"}}}'
wrk.headers["Content-Type"] = "application/json"
wrk.headers["Accept"] = "application/json, text/event-stream"
wrk.headers["Mcp-Session-Id"] = "bench-nonexistent-session"
