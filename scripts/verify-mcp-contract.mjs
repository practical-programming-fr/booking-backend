// Verifies the MCP demo-outage contract against the real app, in process:
// tool inventory, run-handle argument shape, and the FLYLO_MCP_TOKEN gate.
// Run with: node scripts/verify-mcp-contract.mjs

import { tsImport } from "tsx/esm/api";

process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";
process.env.FLYLO_MCP_TOKEN = "verify-mcp-contract-token";

const { buildApp } = await tsImport("../src/app.ts", import.meta.url);
const app = buildApp();

const failures = [];
function check(ok, label) {
  console.log(`${ok ? "ok" : "FAIL"} - ${label}`);
  if (!ok) failures.push(label);
}

const mcpRequest = (body, headers = {}) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };

const unauthorized = await mcpRequest(listBody);
check(unauthorized.status === 401, "missing bearer token is rejected with 401");

const wrongToken = await mcpRequest(listBody, {
  Authorization: "Bearer wrong",
});
check(wrongToken.status === 401, "wrong bearer token is rejected with 401");

const authed = await mcpRequest(listBody, {
  Authorization: `Bearer ${process.env.FLYLO_MCP_TOKEN}`,
});
check(authed.status === 200, "correct bearer token is accepted");

const { result } = await authed.json();
const tools = new Map(result.tools.map((tool) => [tool.name, tool]));

for (const name of [
  "prepare_demo_outage",
  "trigger_demo_outage",
  "clear_demo_outage",
]) {
  check(tools.has(name), `tool ${name} is registered`);
}
check(!tools.has("start_demo_outage"), "start_demo_outage alias is gone");

for (const name of ["trigger_demo_outage", "clear_demo_outage"]) {
  const schema = tools.get(name)?.inputSchema;
  check(
    schema?.required?.includes("runHandle") === true,
    `${name} requires runHandle`,
  );
  check(
    !(schema?.required ?? []).includes("demoSessionId"),
    `${name} does not require demoSessionId`,
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} contract check(s) failed.`);
  process.exit(1);
}
console.log("\nMCP contract verified.");
