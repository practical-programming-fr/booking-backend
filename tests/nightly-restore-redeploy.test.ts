import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const redeployScript = join(repositoryRoot, ".github/scripts/redeploy-vercel.sh");
const nightlyRestoreWorkflow = join(repositoryRoot, ".github/workflows/nightly-restore.yml");
const temporaryDirectories: string[] = [];

const hookUrl =
  "https://deploy-hook.example/nightly/hook-secret?secret=query-secret";
const apiToken = "vercel-token-secret";
const responseSecret = "vercel-response-body-secret";

type Scenario =
  | "hook-success"
  | "hook-network-error"
  | "hook-http-500"
  | "api-success"
  | "api-redeploy-404"
  | "api-no-ready"
  | "api-list-403"
  | "api-list-network-error";

interface RunOptions {
  scenario: Scenario;
  hook?: string;
  token?: string;
  projectId?: string;
}

interface RunResult {
  calls: string[];
  output: string;
  payloads: string[];
  status: number | null;
  writtenEnvironment: string;
}

const fakeCurl = `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const url = [...args].reverse().find((arg) => arg.startsWith("http")) || "";
const hookUrl = process.env.TEST_HOOK_URL;
const scenario = process.env.FAKE_CURL_SCENARIO;
const outputIndex = args.indexOf("-o");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const wantsStatus = args.includes("-w");
const payloadIndex = args.indexOf("-d");
const payload = payloadIndex >= 0 ? args[payloadIndex + 1] : "";

let kind = "unknown";
if (url === hookUrl) {
  kind = "hook";
} else if (url.includes("/v6/deployments")) {
  kind = "api-list";
} else if (url.includes("/redeploy")) {
  kind = "api-redeploy";
} else if (url.includes("/v13/deployments")) {
  kind = "api-create";
}
fs.appendFileSync(process.env.FAKE_CURL_LOG, kind + "\\n");
if (payload) {
  fs.appendFileSync(process.env.FAKE_CURL_PAYLOAD_LOG, kind + "\\t" + payload + "\\n");
}

let body = JSON.stringify({ id: "dpl_new", marker: process.env.RESPONSE_SECRET });
let status = "200";
let exitCode = 0;

if (kind === "hook") {
  if (scenario === "hook-success") {
    status = "201";
  } else if (scenario === "hook-network-error") {
    status = "000";
    body = "";
    exitCode = 7;
  } else {
    status = "500";
  }
} else if (kind === "api-list") {
  if (scenario === "api-list-network-error") {
    status = "000";
    body = "";
    exitCode = 7;
  } else if (scenario === "api-list-403") {
    status = "403";
    body = JSON.stringify({
      error: { message: process.env.RESPONSE_SECRET },
    });
  } else if (scenario === "api-no-ready") {
    body = JSON.stringify({ deployments: [] });
  } else {
    body = JSON.stringify({
      deployments: [
        {
          uid: "dpl_ready",
          state: "READY",
          meta: { githubCommitSha: process.env.BASELINE_SHA },
        },
      ],
    });
  }
} else if (kind === "api-redeploy" && scenario === "api-redeploy-404") {
  status = "404";
}

if (outputPath) {
  fs.writeFileSync(outputPath, body);
} else if (!wantsStatus) {
  process.stdout.write(body);
}
if (wantsStatus) {
  process.stdout.write(status);
}
process.exit(exitCode);
`;

const fakeJq = `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
if (args.includes("-n")) {
  const valueFor = (name) => {
    const index = args.findIndex(
      (arg, position) => arg === "--arg" && args[position + 1] === name,
    );
    return index >= 0 ? args[index + 2] : undefined;
  };
  const project = valueFor("project");
  const deployment = valueFor("deployment");
  if (deployment) {
    process.stdout.write(
      JSON.stringify({
        name: project,
        project,
        deploymentId: deployment,
        target: "production",
      }) + "\\n",
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        name: project,
        project,
        target: "production",
        gitSource: {
          type: "github",
          org: valueFor("organization"),
          repo: valueFor("repository"),
          ref: "main",
          sha: valueFor("sha"),
        },
      }) + "\\n",
    );
  }
  process.exit(0);
}

const input = fs.readFileSync(0, "utf8");
const parsed = input ? JSON.parse(input) : {};
if (args.join(" ").includes(".deployments")) {
  const shaArg = args.findIndex(
    (arg, index) => arg === "--arg" && args[index + 1] === "sha",
  );
  const targetSha = shaArg >= 0 ? args[shaArg + 2].toLowerCase() : "";
  const deployment = (parsed.deployments || []).find((candidate) => {
    const sha =
      candidate.meta?.githubCommitSha ||
      candidate.meta?.gitCommitSha ||
      candidate.meta?.commitSha ||
      candidate.gitSource?.sha ||
      "";
    return candidate.state === "READY" && sha.toLowerCase() === targetSha;
  });
  if (deployment) {
    process.stdout.write((deployment.uid || deployment.id) + "\\n");
  }
} else {
  const id = parsed.id || parsed.uid;
  if (id) {
    process.stdout.write(id + "\\n");
  }
}
`;

function runRedeploy(options: RunOptions): RunResult {
  const directory = mkdtempSync(join(tmpdir(), "flylo-redeploy-test-"));
  temporaryDirectories.push(directory);

  const binDirectory = join(directory, "bin");
  const curlLog = join(directory, "curl.log");
  const payloadLog = join(directory, "payload.log");
  const githubEnvironment = join(directory, "github.env");
  mkdirSync(binDirectory);
  writeFileSync(join(binDirectory, "curl"), fakeCurl, { mode: 0o755 });
  writeFileSync(join(binDirectory, "jq"), fakeJq, { mode: 0o755 });
  writeFileSync(curlLog, "");
  writeFileSync(payloadLog, "");
  writeFileSync(githubEnvironment, "");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    BASELINE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    FAKE_CURL_LOG: curlLog,
    FAKE_CURL_PAYLOAD_LOG: payloadLog,
    FAKE_CURL_SCENARIO: options.scenario,
    GITHUB_ENV: githubEnvironment,
    GITHUB_REPOSITORY: "flylo-air/booking-backend",
    RESPONSE_SECRET: responseSecret,
    TEST_HOOK_URL: hookUrl,
    VERCEL_DEPLOY_HOOK_URL: options.hook,
    VERCEL_PROJECT_ID: options.projectId,
    VERCEL_TEAM_ID: "team-secret",
    VERCEL_TOKEN: options.token,
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const result = spawnSync("bash", [redeployScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });

  return {
    calls: readFileSync(curlLog, "utf8").trim().split("\n").filter(Boolean),
    output: `${result.stdout}${result.stderr}`,
    payloads: readFileSync(payloadLog, "utf8").trim().split("\n").filter(Boolean),
    status: result.status,
    writtenEnvironment: readFileSync(githubEnvironment, "utf8"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("nightly Vercel redeploy", () => {
  it("uses a successful hook before invalid API credentials", () => {
    const result = runRedeploy({
      scenario: "hook-success",
      hook: hookUrl,
      token: "expired-token",
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["hook"]);
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=triggered via deploy hook (HTTP 201)",
    );
  });

  it("falls back to the API after a hook network error", () => {
    const result = runRedeploy({
      scenario: "hook-network-error",
      hook: hookUrl,
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["hook", "api-list", "api-redeploy"]);
    expect(result.output).toContain("deploy hook network error");
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=triggered via API redeploy (HTTP 200, deployment dpl_new)",
    );
  });

  it("falls back to the API after a hook HTTP 500", () => {
    const result = runRedeploy({
      scenario: "hook-http-500",
      hook: hookUrl,
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["hook", "api-list", "api-redeploy"]);
    expect(result.output).toContain("deploy hook failed (HTTP 500)");
  });

  it("preserves the API path when the hook is absent", () => {
    const result = runRedeploy({
      scenario: "api-success",
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["api-list", "api-redeploy"]);
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=triggered via API redeploy",
    );
  });

  it("falls back from an unavailable redeploy endpoint to create-deployment", () => {
    const result = runRedeploy({
      scenario: "api-redeploy-404",
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["api-list", "api-redeploy", "api-create"]);
    expect(result.payloads.at(-1)).toContain('"deploymentId":"dpl_ready"');
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=triggered via API redeploy",
    );
  });

  it("creates from gitSource when no READY deployment matches", () => {
    const result = runRedeploy({
      scenario: "api-no-ready",
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["api-list", "api-create"]);
    expect(result.payloads.at(-1)).toContain(
      '"gitSource":{"type":"github","org":"flylo-air","repo":"booking-backend","ref":"main","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    );
  });

  it("skips an absent hook with incomplete API credentials", () => {
    const result = runRedeploy({
      scenario: "api-success",
      token: apiToken,
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=skipped: no deploy hook and missing API credentials",
    );
  });

  it("reports a failed hook when API fallback credentials are incomplete", () => {
    const result = runRedeploy({
      scenario: "hook-http-500",
      hook: hookUrl,
      token: apiToken,
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["hook"]);
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=failed: deploy hook HTTP 500; API fallback unavailable",
    );
  });

  it("creates from gitSource after a deployment-list HTTP 403", () => {
    const result = runRedeploy({
      scenario: "api-list-403",
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["api-list", "api-create"]);
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=triggered via API redeploy",
    );
    expect(result.output).not.toContain("No READY deployment found");
  });

  it("creates from gitSource after a deployment-list network error", () => {
    const result = runRedeploy({
      scenario: "api-list-network-error",
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["api-list", "api-create"]);
    expect(result.writtenEnvironment).toContain(
      "VERCEL_REDEPLOY_STATUS=triggered via API redeploy",
    );
    expect(result.output).toContain(
      "Deployment list unavailable. Creating directly from gitSource.",
    );
  });

  it("does not print hook, token, query, or response secrets", () => {
    const result = runRedeploy({
      scenario: "hook-http-500",
      hook: hookUrl,
      token: apiToken,
      projectId: "project-test",
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain(hookUrl);
    expect(result.output).not.toContain(apiToken);
    expect(result.output).not.toContain("query-secret");
    expect(result.output).not.toContain(responseSecret);
  });

  // nightly-restore.yml is omitted from this mirror (workflow OAuth scope).
  // The ordering assertion runs again when that file is present.
  it.skipIf(!existsSync(nightlyRestoreWorkflow))(
    "keeps the baseline SHA health gate after the extracted script",
    () => {
      const workflow = readFileSync(nightlyRestoreWorkflow, "utf8");
      const redeployStep = workflow.indexOf(
        "run: bash .github/scripts/redeploy-vercel.sh",
      );
      const healthGate = workflow.indexOf(
        "- name: Wait for the baseline deploy to go live",
      );

      expect(redeployStep).toBeGreaterThan(-1);
      expect(healthGate).toBeGreaterThan(redeployStep);
      expect(workflow).toContain(
        "Refusing to migrate/reseed against the wrong deployment.",
      );
    },
  );
});
