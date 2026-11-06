import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { request } from "node:http";
import { isLoopbackBindHost, resolveS2sSecret, startHttpTransport } from "../index.js";

// Obviously fake, not a real secret.
const FAKE_SECRET = "fake-test-secret-".padEnd(40, "0");

function withExit(fn: () => unknown): string {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  } finally {
    exit.mockRestore();
  }
}

describe("resolveS2sSecret", () => {
  it("accepts a >=32 char secret", () => {
    expect(resolveS2sSecret({ CONDUIT_S2S_SECRET: FAKE_SECRET }).secret).toBe(FAKE_SECRET);
  });
  it("rejects short secrets and placeholders without printing the value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases = [
      "short-secret-value", "changeme", "Change-Me", "secret", "placeholder",
      "x".repeat(40), "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "0".repeat(40),
      "your-secret-goes-here-please-replace", "your_s2s_secret_value_goes_here_1234", "CHANGEME-" + "a".repeat(30),
      "replace-with-a-real-secret-value-please",
      "a".repeat(40), "1".repeat(40), "-".repeat(40), "Z".repeat(64), "A".repeat(32),
    ];
    for (const value of cases) {
      expect(withExit(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: value })), value).toBe("exit:1");
      const logged = err.mock.calls.map((c) => String(c[0])).join("");
      if (value.length > 12) expect(logged).not.toContain(value);
    }
    err.mockRestore();
  });
  it("accepts a real hex secret", () => {
    const hex = "9f2c4be07a1d83c65e0b7f4a2d19c8e3b5a60714d2f8e9c3a1b7d5e60f482c9a";
    expect(resolveS2sSecret({ CONDUIT_S2S_SECRET: hex }).secret).toBe(hex);
  });
  it("rejects a short secret even with MCP_ALLOW_INSECURE_DEV=1; empty+dev is allowed", () => {
    expect(withExit(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: "tiny", MCP_ALLOW_INSECURE_DEV: "1" }))).toBe("exit:1");
    expect(withExit(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: "x".repeat(40), MCP_ALLOW_INSECURE_DEV: "1" }))).toBe("exit:1");
    expect(withExit(() => resolveS2sSecret({}))).toBe("exit:1");
    expect(resolveS2sSecret({ MCP_ALLOW_INSECURE_DEV: "1" })).toEqual({ secret: "", insecureDev: true });
  });
});

describe("isLoopbackBindHost", () => {
  it("recognises loopback addresses only", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackBindHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.1", "example.com", "::", "128.0.0.1"]) expect(isLoopbackBindHost(h)).toBe(false);
  });
});

function send(port: number, opts: { host?: string; path?: string; body?: string; method?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: opts.path ?? "/mcp", method: opts.method ?? "POST", headers: { ...(opts.host ? { Host: opts.host } : {}), "Content-Type": "application/json", ...opts.headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function s2sHeader(secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`t=${t}`).digest("hex")}`;
}

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(env: Record<string, string>): Promise<number> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = { MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: "127.0.0.1", FOREMAN_BASE_URL: "https://foreman.test.invalid", AUTH_MODE: "env", ...env };
  for (const [k, v] of Object.entries(base)) vi.stubEnv(k, v);
  server = await startHttpTransport();
  return (server.address() as AddressInfo).port;
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const ACCEPT = { Accept: "application/json, text/event-stream" };

describe("Host header check (DNS rebinding)", () => {
  it("rejects unknown hosts with 403 and allows localhost, with or without port", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    expect((await send(port, { host: "evil.example.net", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "evil.example.net:80", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "localhost:99999", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "localhost", body: "{}" })).status).not.toBe(403);
    expect((await send(port, { host: `127.0.0.1:${port}`, body: "{}" })).status).not.toBe(403);
  });
  it("honours MCP_ALLOWED_HOSTS and warns on entries with ports", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await start({ CONDUIT_S2S_SECRET: FAKE_SECRET, MCP_ALLOWED_HOSTS: "mcp.example.com, bad.example.com:8080, ::1" });
    const logged = err.mock.calls.map((c) => String(c[0])).join("");
    err.mockRestore();
    expect(logged).toContain("bad.example.com:8080");
    expect(logged).toContain('"::1"');
    // Allowed host passes the host check and then fails S2S auth (401), not 403.
    expect((await send(port, { host: "mcp.example.com", body: "{}" })).status).toBe(401);
    expect((await send(port, { host: "other.example.com", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "bad.example.com:8080", body: "{}" })).status).toBe(403);
  });
  it("does not gate /health", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    expect((await send(port, { host: "evil.example.net", path: "/health", method: "GET" })).status).toBe(200);
  });
});

describe("S2S enforcement", () => {
  it("rejects /mcp without a valid X-Gateway-S2S header and accepts a signed one", async () => {
    const port = await start({ CONDUIT_S2S_SECRET: FAKE_SECRET });
    expect((await send(port, { body: INIT, headers: ACCEPT })).status).toBe(401);
    expect((await send(port, { body: INIT, headers: { ...ACCEPT, "X-Gateway-S2S": s2sHeader("some-other-fake-secret-value-0123456789") } })).status).toBe(401);
    expect((await send(port, { body: INIT, headers: { ...ACCEPT, "X-Gateway-S2S": s2sHeader(FAKE_SECRET) } })).status).toBe(200);
  });
});

describe("request body limit", () => {
  it("returns 413 for a declared or streamed body over 1 MiB, 400 for bad JSON", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    const big = JSON.stringify({ pad: "a".repeat(1024 * 1024 + 10) });
    expect((await send(port, { body: big })).status).toBe(413);
    expect((await send(port, { body: "not json" })).status).toBe(400);
  });
  it("accepts a body under the limit", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    expect((await send(port, { body: INIT, headers: ACCEPT })).status).toBe(200);
  });
});

describe("gateway mode", () => {
  it("answers 401 without credential headers, even when env credentials are set", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1", AUTH_MODE: "gateway", FOREMAN_USERNAME: "env-user", FOREMAN_TOKEN: "env-fake-token" });
    for (const headers of [{}, { "X-Foreman-Username": "gw-user" }, { "X-Foreman-Token": "gw-fake-token" }] as Array<Record<string, string>>) {
      const res = await send(port, { body: INIT, headers: { ...ACCEPT, ...headers } });
      expect(res.status).toBe(401);
      expect(res.body).not.toContain("env-fake-token");
    }
  });

  it("accepts the headers in any case and uses them for the upstream call", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1", AUTH_MODE: "gateway", FOREMAN_TOOL_TIERS: "read", FOREMAN_USERNAME: "env-user", FOREMAN_TOKEN: "env-fake-token" });
    const upstream = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "foreman_hosts_list", arguments: {} } });
    const res = await send(port, { body: call, headers: { ...ACCEPT, "X-FOREMAN-USERNAME": "gw-user", "x-Foreman-Token": "gw-fake-token" } });
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const init = (upstream.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("gw-user:gw-fake-token").toString("base64")}`);
  });
});
