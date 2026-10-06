# DifSync Architecture

## Runtime boundaries

### Browser
The browser receives no connector credentials and no agent tokens. Authentication is an HttpOnly secure cookie.

### Hub
The Hub owns identity, authorization, device ownership, command queues, pairing and encrypted connector configuration. It binds to loopback in production and sits behind Nginx or another reverse proxy.

### Local Agent
The local agent performs hardware I/O. It receives a single per-agent bearer token at pairing time. The Hub stores only a hash of that token.

## Ownership hierarchy

```
User
├── Agents
│   ├── Inventory
│   └── Command queue
└── Connectors
    ├── Govee
    ├── Philips Hue
    ├── Google Home
    └── Amazon Alexa
```

Every read and write checks the authenticated user's ID against the resource owner.

## Connector model

Connectors are isolated adapters. Their encrypted configuration is stored in the Hub database and decrypted only during a server-side provider operation.

Google Home and Alexa are represented as provider integrations because production use requires OAuth/provider console setup and certification. They are not treated as simple API-key connectors.
