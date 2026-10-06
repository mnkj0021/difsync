# DifSync Agent Protocol

The local agent pairs once with a user account and receives a per-agent bearer token.

## Pair

`POST /api/agent/pair`

```json
{
  "code": "ABCDEFGH",
  "agent_id": "machine-stable-id",
  "name": "Gaming PC",
  "platform": "windows",
  "version": "0.1.0"
}
```

The returned `agent_token` is shown only once. Store it using the operating system's protected credential storage where possible.

## Pull

`POST /api/agent/pull`

Header: `Authorization: Bearer <agent-token>`

The agent can include a safe inventory snapshot. Never upload device credentials, provider keys or unrelated machine information.

## Acknowledge

`POST /api/agent/ack`

Acknowledges one command belonging to the authenticated agent.

## Trust boundary

The Hub does not perform PC hardware I/O. The local agent owns that boundary.
