import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { loadEnv } from "../env.js";
import { createBookingMcpServer, type InternalFetch } from "../mcp/server.js";

type McpRoutesOptions = {
  internalFetch: InternalFetch;
};

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST",
      },
    },
  );
}

export function mcpRoutes(options: McpRoutesOptions): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const env = loadEnv();
    const server = createBookingMcpServer({
      internalFetch: options.internalFetch,
      env,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      console.error("[booking-mcp]", err);
      return jsonRpcError(500, -32603, "Internal server error");
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  app.get("/", () => jsonRpcError(405, -32000, "Method not allowed."));
  app.delete("/", () => jsonRpcError(405, -32000, "Method not allowed."));
  app.all("*", () => jsonRpcError(405, -32000, "Method not allowed."));

  return app;
}
