# Connectors

## Govee

DifSync stores the user's Govee Developer API key encrypted with AES-256-GCM. Provider calls execute in the Hub.

## Philips Hue

Hue is local-network hardware. Its bridge address and application key are associated with a paired agent so control can execute on the user's LAN rather than pretending a public VPS can reach a private bridge.

## Google Home

Google Home cloud-to-cloud integrations use OAuth authorization-code account linking plus Google Home fulfillment/certification. DifSync includes the provider slot but intentionally does not claim production linkage until a Google Home developer project is configured.

## Amazon Alexa

Alexa Smart Home integrations require account linking and provider-side skill configuration/certification. DifSync includes the provider slot and keeps those credentials server-side when configured.
