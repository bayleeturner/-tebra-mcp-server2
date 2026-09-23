# Tebra MCP Server — read-only starter

This project creates a remote MCP server that sits between ChatGPT and the Tebra FHIR API.

Architecture:

ChatGPT -> HTTPS MCP endpoint -> this server -> Tebra OAuth -> Tebra FHIR API

## Important

This starter intentionally exposes **read-only** tools. It does not create patients,
upload documents, or modify Tebra records.

Tebra's current FHIR documentation describes a production FHIR base URL of
`https://fhir.prd.cloud.tebra.com/fhir-request` and OAuth endpoints under
`https://fhir.prd.cloud.tebra.com/smartauth/`.

Do not put the Tebra FHIR URL directly into ChatGPT's MCP Server URL field.
The ChatGPT field must point to this server's `/mcp` endpoint after deployment.

## Tools

- search_patient
- get_patient
- get_patient_documents
- get_patient_encounters

## Local test

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Fill in Tebra credentials and a strong `MCP_ACCESS_TOKEN`.
4. Run:

   npm install
   npm run dev

The local MCP endpoint will be:

   http://localhost:3000/mcp

ChatGPT cannot normally connect directly to localhost. For ChatGPT, deploy this
server to a trusted HTTPS host, or use a supported secure MCP tunnel.

## ChatGPT configuration

After deployment, use:

Name: Tebra
Type: URL
Server URL: https://YOUR-HOST.example.com/mcp

Add an HTTP header:

Key: Authorization
Value: Bearer YOUR_MCP_ACCESS_TOKEN

Do NOT put the Tebra client secret in ChatGPT. The Tebra client ID/secret belong
on the MCP server as environment variables.

## Security

This server handles PHI. Use a hosting/workspace setup approved by your organization
and verify your HIPAA/BAA and Tebra contractual requirements before sending live
patient data through it. Do not log patient responses or OAuth tokens.

## Tebra authentication

This starter uses Tebra's backend-service/client-credentials model. Tebra's
documentation says backend services use the client-credentials workflow and require
a client ID and client secret. Your Tebra app must be registered/approved with the
scopes it needs.

If Tebra gave your application different token-authentication requirements, adjust
`getTebraAccessToken()` in `src/server.ts` accordingly.
