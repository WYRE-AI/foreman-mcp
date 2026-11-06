#!/usr/bin/env node
// Offline smoke test: starts dist/index.js against a mock Foreman server on
// 127.0.0.1. No network access to any real Foreman host is made.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_USERNAME = "foreman-user";
const TEST_TOKEN = "smoke-fake-token";
const basic = (user, token) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
const failures = [];

function check(condition, message) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
}

const seen = [];
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept, body });
    res.setHeader("Content-Type", "application/json");
    if (!req.headers.authorization?.startsWith("Basic ")) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: "Invalid credentials" } }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ host: { id: 7, name: "foreman-test" } }));
  });
});

await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;
const textOf = (result) => result.content.map((content) => content.text ?? "").join("");

async function withServer(extraEnv, fn) {
  const env = { ...getDefaultEnvironment(), FOREMAN_BASE_URL: mockUrl, LOG_LEVEL: "warn", ...extraEnv };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, "dist/index.js")], env, stderr: "inherit" });
  const client = new Client({ name: "foreman-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

function runHttpExit(env) {
  return new Promise((resolveExit) => {
    const proc = spawn(process.execPath, [resolve(root, "dist/index.js")], { env: { ...getDefaultEnvironment(), LOG_LEVEL: "warn", ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      proc.kill();
      resolveExit({ code: "timeout", stderr });
    }, 5000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolveExit({ code, stderr });
    });
  });
}

try {
  console.log("\n[1] tier counts");
  await withServer({ FOREMAN_USERNAME: TEST_USERNAME, FOREMAN_TOKEN: TEST_TOKEN }, async (client) => {
    const { tools } = await client.listTools();
    check(tools.length === 47, "47 read tools at default tiers");
    check(new Set(tools.map((tool) => tool.name)).size === tools.length, "tool names are unique");
    check(tools.every((tool) => tool.inputSchema.type === "object" && tool.inputSchema.properties !== undefined), "every tool has a declared inputSchema");
  });
  await withServer({ FOREMAN_USERNAME: TEST_USERNAME, FOREMAN_TOKEN: TEST_TOKEN, FOREMAN_TOOL_TIERS: "read,write,admin" }, async (client) => {
    const { tools } = await client.listTools();
    check(tools.length === 72, "72 tools with all tiers enabled");
  });

  console.log("\n[2] mocked read over stdio");
  await withServer({ FOREMAN_USERNAME: TEST_USERNAME, FOREMAN_TOKEN: TEST_TOKEN }, async (client) => {
    const result = await client.callTool({ name: "foreman_host_get", arguments: { id: "foreman-test" } });
    check(!result.isError && JSON.parse(textOf(result)).host.name === "foreman-test", "foreman_host_get returns the mocked payload");
    const list = await client.callTool({ name: "foreman_hosts_list", arguments: { search: "name ~ web", per_page: 5 } });
    check(!list.isError, "foreman_hosts_list succeeds");
    const bogus = await client.callTool({ name: "foreman_host_get", arguments: { id: "x", bogus: "1" } });
    check(bogus.isError === true, "an undeclared argument is rejected");
    const traversal = await client.callTool({ name: "foreman_host_get", arguments: { id: "../users" } });
    check(traversal.isError === true, "a path-traversal id is rejected");
  });
  const getHost = seen.find((r) => r.url === "/api/hosts/foreman-test");
  check(getHost?.auth === basic(TEST_USERNAME, TEST_TOKEN) && getHost.accept === "application/json,version=2", "request used Basic auth and the version=2 Accept header");
  check(seen.some((r) => r.url === "/api/hosts?search=name+%7E+web&per_page=5"), "list arguments were sent as the query string");
  check(!seen.some((r) => r.url.includes("bogus") || r.url.includes("users")), "no bogus or traversal request reached the server");

  console.log("\n[base-url] no default FOREMAN_BASE_URL");
  await withServer({ FOREMAN_BASE_URL: undefined, FOREMAN_USERNAME: TEST_USERNAME, FOREMAN_TOKEN: TEST_TOKEN }, async (client) => {
    const { tools } = await client.listTools();
    check(tools.length === 47, "stdio with FOREMAN_BASE_URL unset still lists tools");
    const result = await client.callTool({ name: "foreman_host_get", arguments: { id: "x" } });
    check(result.isError === true && textOf(result).includes("FOREMAN_BASE_URL is required"), "stdio with FOREMAN_BASE_URL unset: tool calls return is_error");
  });
  await withServer({ FOREMAN_BASE_URL: undefined }, async (client) => {
    const result = await client.callTool({ name: "foreman_host_get", arguments: { id: "x" } });
    check(result.isError === true, "stdio with no env at all: tool calls return is_error");
  });
  const httpExit = await runHttpExit({ MCP_TRANSPORT: "http", AUTH_MODE: "env", MCP_HTTP_PORT: "18999", MCP_ALLOW_INSECURE_DEV: "1" });
  check(httpExit.code === 1 && httpExit.stderr.includes("FOREMAN_BASE_URL is required"), "http mode with FOREMAN_BASE_URL unset exits 1 at startup");

  console.log("\n[3] http transport startup checks");
  const noSecret = await runHttpExit({ MCP_TRANSPORT: "http", FOREMAN_BASE_URL: mockUrl, MCP_HTTP_PORT: "18998" });
  check(noSecret.code === 1 && noSecret.stderr.includes("CONDUIT_S2S_SECRET"), "http mode without CONDUIT_S2S_SECRET exits 1");
  const placeholder = await runHttpExit({ MCP_TRANSPORT: "http", FOREMAN_BASE_URL: mockUrl, MCP_HTTP_PORT: "18998", CONDUIT_S2S_SECRET: "x".repeat(40) });
  check(placeholder.code === 1 && !placeholder.stderr.includes("x".repeat(40)), "a 40-char placeholder secret is refused and not printed");

  console.log("\n[4] gateway mode reads credentials from X-Foreman-* headers");
  const port = 18000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [resolve(root, "dist/index.js")], {
    env: { ...getDefaultEnvironment(), FOREMAN_BASE_URL: mockUrl, FOREMAN_USERNAME: "env-user", FOREMAN_TOKEN: "env-fake-token", AUTH_MODE: "gateway", MCP_TRANSPORT: "http", MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: "127.0.0.1", MCP_ALLOW_INSECURE_DEV: "1", LOG_LEVEL: "error" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    check(healthy, "HTTP server is healthy");
    const noHeaders = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    check(noHeaders.status === 401, "request without X-Foreman-* headers is rejected (no env fallback)");
    const client = new Client({ name: "foreman-smoke-http", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { "X-Foreman-Username": "gw-user", "X-Foreman-Token": "gw-fake-token" } } }));
    const result = await client.callTool({ name: "foreman_host_get", arguments: { id: "gw-host" } });
    await client.close();
    check(!result.isError && seen.at(-1)?.auth === basic("gw-user", "gw-fake-token"), "gateway credentials were used for the upstream call");
    check(!seen.some((r) => r.auth === basic("env-user", "env-fake-token")), "environment credentials were never used");
  } finally {
    child.kill();
  }
} catch (error) {
  console.error("smoke test crashed:", error);
  failures.push("crash");
} finally {
  await new Promise((r) => mock.close(r));
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");
