# DifSync MCP gateway

DifSync includes a private MCP gateway in `services/mcp`.

The first public version is deliberately read-only. It exposes:

- `devices_list`
- `device_inventory`
- `read_file` for allowlisted Oracle paths
- `list_directory` for allowlisted Oracle paths

The public repository does not expose unrestricted remote shell or write primitives. Those belong in a private deployment policy layer, with explicit approval and narrow filesystem roots.

## Oracle deployment

From the DifSync checkout:

```bash
npm install
DIFSYNC_MCP_USER_EMAIL="you@example.com" \
DIFSYNC_MCP_READ_ROOTS="/home/opc/projects/difsync" \
npm --workspace services/mcp start
```

The MCP server speaks stdio and is intended to be launched by a trusted host or Secure MCP Tunnel client.

## Secure MCP Tunnel

OpenAI Secure MCP Tunnel keeps the MCP server private. Create a tunnel in OpenAI Platform, install `tunnel-client` on the Oracle VPS, then configure it with the DifSync MCP stdio command.

Example shape:

```bash
export CONTROL_PLANE_API_KEY="set-in-the-service-environment"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile difsync-oracle \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-command "npm --prefix /home/opc/projects/difsync --workspace services/mcp start"

tunnel-client doctor --profile difsync-oracle --explain
tunnel-client run --profile difsync-oracle
```

Do not commit the runtime API key or tunnel credentials.

## Device presence agent

`agents/device-agent` is a small cross-platform presence agent. It pairs to a DifSync account using a one-time code from the dashboard, stores the resulting per-agent token in `~/.difsync-agent/config.json`, and sends safe inventory/heartbeat information to the Hub.

The first public version does not execute remote commands.

```bash
DIFSYNC_PAIR_CODE="ONE_TIME_CODE" npm --workspace agents/device-agent start
```

After pairing, start it normally without the code.

## ChatGPT availability

Custom MCP access in ChatGPT depends on the user's plan/workspace permissions. The Oracle gateway can also be consumed by Codex or other MCP-compatible clients independently of ChatGPT plan availability.
