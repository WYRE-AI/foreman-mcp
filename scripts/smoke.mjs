#!/usr/bin/env node
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_USERNAME = "foreman-user";
const TEST_TOKEN = "foreman-token";
const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
}

const seen = [];
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET" || req.headers.authorization !== `Basic ${Buffer.from(`${TEST_USERNAME}:${TEST_TOKEN}`).toString("base64")}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: "Invalid credentials" } }));
      return;
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200);
    res.end(JSON.stringify({ host: { id: 7, name: "foreman-test" } }));
  });
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

async function withServer(extraEnv, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/index.js")],
    env: { ...getDefaultEnvironment(), FOREMAN_BASE_URL: mockUrl, LOG_LEVEL: "warn", ...extraEnv },
    stderr: "inherit",
  });
  const client = new Client({ name: "foreman-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

const textOf = (result) => result.content.map((content) => content.text ?? "").join("");

try {
  console.log("\n[1] default tiers (read only)");
  await withServer({ FOREMAN_USERNAME: TEST_USERNAME, FOREMAN_TOKEN: TEST_TOKEN }, async (client) => {
    const { tools } = await client.listTools();
    console.log(`  tools listed: ${tools.length}`);
    check(tools.length === 47, "47 read tools at default tiers");
    check(new Set(tools.map((tool) => tool.name)).size === tools.length, "tool names are unique");

    const result = await client.callTool({ name: "foreman_host_get", arguments: { id: "foreman-test" } });
    console.log(`  foreman_host_get -> ${textOf(result)}`);
    check(!result.isError, "read tool executes successfully");
    check(JSON.parse(textOf(result)).host.name === "foreman-test", "read tool returns expected payload");
  });
} catch (error) {
  console.error("smoke test crashed:", error);
  failures.push("crash");
} finally {
  await new Promise((resolve) => mock.close(resolve));
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");
