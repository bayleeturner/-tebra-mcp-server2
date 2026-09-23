import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT ?? 3000);

const TEBRA_BASE =
  process.env.TEBRA_FHIR_BASE ??
  "https://fhir.prd.cloud.tebra.com/fhir-request";

const TEBRA_TOKEN_URL =
  process.env.TEBRA_TOKEN_URL ??
  "https://fhir.prd.cloud.tebra.com/smartauth/oauth/token";

const CLIENT_ID = process.env.TEBRA_CLIENT_ID;
const CLIENT_SECRET = process.env.TEBRA_CLIENT_SECRET;
const TEBRA_SCOPE = process.env.TEBRA_SCOPE ?? "";
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !MCP_ACCESS_TOKEN) {
  throw new Error(
    "Missing TEBRA_CLIENT_ID, TEBRA_CLIENT_SECRET, or MCP_ACCESS_TOKEN."
  );
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getTebraAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
  });

  if (TEBRA_SCOPE) body.set("scope", TEBRA_SCOPE);

  const response = await fetch(TEBRA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Tebra OAuth failed (${response.status}): ${detail}`);
  }

  const token = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!token.access_token) {
    throw new Error("Tebra OAuth response did not contain access_token.");
  }

  cachedToken = {
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in ?? 300) * 1000,
  };

  return token.access_token;
}

async function tebraGet(
  resource: string,
  params: Record<string, string | undefined>
): Promise<unknown> {
  const token = await getTebraAccessToken();

  const url = new URL(`${TEBRA_BASE}/${resource}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/fhir+json, application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    // Avoid returning tokens or internal credentials.
    throw new Error(`Tebra API request failed (${response.status}). ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function createServerInstance() {
  const server = new McpServer(
    { name: "tebra-readonly", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "search_patient",
    {
      title: "Search Tebra patients",
      description:
        "Read-only search of Tebra FHIR Patient records. Use name, identifier, birthdate, or gender+name as supported by Tebra.",
      inputSchema: {
        name: z.string().optional(),
        identifier: z.string().optional(),
        birthdate: z.string().optional(),
        gender: z.string().optional(),
      },
    },
    async ({ name, identifier, birthdate, gender }) => {
      const result = await tebraGet("Patient", {
        name,
        identifier,
        birthdate,
        gender,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "get_patient",
    {
      title: "Get Tebra patient",
      description: "Read-only retrieval of one Tebra FHIR Patient by patient ID.",
      inputSchema: {
        patientId: z.string(),
      },
    },
    async ({ patientId }) => {
      const result = await tebraGet("Patient", { id: patientId });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "get_patient_documents",
    {
      title: "Get Tebra patient documents",
      description:
        "Read-only retrieval of Tebra DocumentReference records for a patient, including available clinical notes/documents.",
      inputSchema: {
        patientId: z.string(),
        category: z.string().optional(),
        type: z.string().optional(),
        date: z.string().optional(),
      },
    },
    async ({ patientId, category, type, date }) => {
      const result = await tebraGet("DocumentReference", {
        patient: patientId,
        category,
        type,
        date,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    "get_patient_encounters",
    {
      title: "Get Tebra patient encounters",
      description: "Read-only retrieval of Tebra encounters for a patient.",
      inputSchema: {
        patientId: z.string(),
        date: z.string().optional(),
      },
    },
    async ({ patientId, date }) => {
      const result = await tebraGet("Encounter", {
        patient: patientId,
        date,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(createServerInstance);

const nodeHandler = toNodeHandler(mcpHandler);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Simple health endpoint for the hosting provider.
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "tebra-mcp-server" }));
    return;
  }

  // Protect the MCP endpoint with a separate secret.
  if (req.url?.startsWith("/mcp")) {
    const authorization = req.headers.authorization ?? "";
    const expected = `Bearer ${MCP_ACCESS_TOKEN}`;

    if (authorization !== expected) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="tebra-mcp"',
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    await nodeHandler(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Tebra MCP server listening on port ${PORT}`);
});
