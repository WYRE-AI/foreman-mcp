import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MESSAGE_CHARS,
  buildPath,
  buildRequest,
  executeForemanRequest,
  getAgent,
  getBaseUrl,
  getCredentials,
  redactAndTruncate,
  redactData,
  resolveBaseUrl,
  resolveRequestCredentials,
  runWithCredentials,
} from "../utils/client.js";
import type { ForemanCredentials } from "../utils/types.js";

const ORIGINAL = { ...process.env };
// Obviously fake values.
const CREDS: ForemanCredentials = { username: "foreman-user", token: "fake-pat-for-tests", baseUrl: "https://foreman.test.invalid" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  for (const key of ["FOREMAN_BASE_URL", "FOREMAN_USERNAME", "FOREMAN_TOKEN", "FOREMAN_CA_CERT_FILE", "AUTH_MODE"]) delete process.env[key];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe("base URL", () => {
  it("is required, with no default", () => {
    expect(() => resolveBaseUrl(undefined)).toThrow(/FOREMAN_BASE_URL is required/);
    expect(() => resolveBaseUrl("   ")).toThrow(/FOREMAN_BASE_URL is required/);
    expect(() => getBaseUrl({})).toThrow(/FOREMAN_BASE_URL is required/);
  });

  it("allows any https host, including private IPs and ports; strips trailing slashes", () => {
    expect(resolveBaseUrl("https://foreman.corp.internal")).toBe("https://foreman.corp.internal");
    expect(resolveBaseUrl("https://10.1.2.3:8443/")).toBe("https://10.1.2.3:8443");
    expect(resolveBaseUrl("https://host.test.invalid/foreman//")).toBe("https://host.test.invalid/foreman");
    expect(resolveBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(resolveBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("rejects http for remote hosts, other schemes, userinfo, query and hash", () => {
    expect(() => resolveBaseUrl("http://foreman.test.invalid")).toThrow(/http is only allowed for localhost/);
    expect(() => resolveBaseUrl("ftp://foreman.test.invalid")).toThrow(/only https/);
    expect(() => resolveBaseUrl("https://user:pw@foreman.test.invalid")).toThrow(/userinfo/);
    expect(() => resolveBaseUrl("https://user@foreman.test.invalid")).toThrow(/userinfo/);
    expect(() => resolveBaseUrl("https://foreman.test.invalid/#frag")).toThrow();
    expect(() => resolveBaseUrl("https://foreman.test.invalid/?a=b")).toThrow();
    expect(() => resolveBaseUrl("not a url")).toThrow(/not a valid URL/);
  });
});

describe("credentials", () => {
  it("reads env credentials and the base URL", () => {
    process.env.FOREMAN_BASE_URL = "https://foreman.test.invalid";
    process.env.FOREMAN_USERNAME = "foreman-user";
    process.env.FOREMAN_TOKEN = "fake-pat-for-tests";
    expect(getCredentials()).toEqual(CREDS);
  });

  it("returns the base-URL error before anything else when it is unset", () => {
    process.env.FOREMAN_USERNAME = "foreman-user";
    process.env.FOREMAN_TOKEN = "fake-pat-for-tests";
    expect(getCredentials()).toEqual({ error: expect.stringContaining("FOREMAN_BASE_URL is required") });
  });

  it("gateway header lookup is lowercase and never reads env credentials", () => {
    process.env.FOREMAN_BASE_URL = "https://foreman.test.invalid";
    process.env.FOREMAN_USERNAME = "env-user";
    process.env.FOREMAN_TOKEN = "env-fake-token";
    const seen: string[] = [];
    const headers: Record<string, string> = { "x-foreman-username": "gw-user", "x-foreman-token": "gw-fake-token" };
    const result = getCredentials(undefined, (name) => {
      seen.push(name);
      return headers[name];
    });
    expect(result).toEqual({ username: "gw-user", token: "gw-fake-token", baseUrl: "https://foreman.test.invalid" });
    expect(seen.every((name) => name === name.toLowerCase())).toBe(true);
    expect(getCredentials(undefined, () => undefined)).toEqual({ error: expect.stringContaining("Missing X-Foreman-Username or X-Foreman-Token") });
    expect(getCredentials(undefined, (n) => (n === "x-foreman-username" ? "gw-user" : undefined))).toHaveProperty("error");
  });

  it("rejects usernames with ':' and tokens with control characters", () => {
    process.env.FOREMAN_BASE_URL = "https://foreman.test.invalid";
    const headers = (u: string, t: string) => (n: string) => (n === "x-foreman-username" ? u : t);
    expect(getCredentials(undefined, headers("a:b", "tok"))).toHaveProperty("error");
    expect(getCredentials(undefined, headers("user", "to\nk"))).toHaveProperty("error");
  });

  it("gateway mode has no environment fallback; scoped credentials win", async () => {
    process.env.FOREMAN_BASE_URL = "https://foreman.test.invalid";
    process.env.FOREMAN_USERNAME = "env-user";
    process.env.FOREMAN_TOKEN = "env-fake-token";
    expect(resolveRequestCredentials()).toHaveProperty("username", "env-user");
    process.env.AUTH_MODE = "gateway";
    expect(resolveRequestCredentials()).toEqual({ error: expect.stringContaining("gateway mode") });
    const scoped = runWithCredentials({ ...CREDS, username: "scoped" }, () => resolveRequestCredentials());
    expect(scoped).toHaveProperty("username", "scoped");
    // Two concurrent requests never see each other's credentials.
    const seen = await Promise.all(
      ["a", "b"].map((u) =>
        runWithCredentials({ ...CREDS, username: u }, async () => {
          await new Promise((r) => setTimeout(r, u === "a" ? 10 : 0));
          return (resolveRequestCredentials() as ForemanCredentials).username;
        }),
      ),
    );
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("buildPath", () => {
  it("replaces every placeholder by exact token ( :id never clobbers :host_id )", () => {
    expect(buildPath("/api/hosts/:host_id/interfaces/:id", { host_id: "H1", id: "I2" })).toBe("/api/hosts/H1/interfaces/I2");
    expect(buildPath("/api/hosts/:id/status/:type", { id: "web01.test.invalid", type: "build" })).toBe("/api/hosts/web01.test.invalid/status/build");
  });

  it("encodes values", () => {
    expect(buildPath("/api/hosts/:id", { id: "a b?c#d%e" })).toBe("/api/hosts/a%20b%3Fc%23d%25e");
    expect(buildPath("/api/hosts/:id", { id: 7 })).toBe("/api/hosts/7");
  });

  it("rejects empty, dot segments, slashes, backslashes, control characters, wrong types and missing values", () => {
    for (const bad of ["", "  ", ".", "..", "a/b", "../x", "a\\b", "a\nb", "a\u0000b", "\u007f"]) {
      expect(() => buildPath("/api/hosts/:id", { id: bad }), JSON.stringify(bad)).toThrow(/path parameter "id"/);
    }
    expect(() => buildPath("/api/hosts/:id", { id: { x: 1 } })).toThrow(/string or number/);
    expect(() => buildPath("/api/hosts/:id", {})).toThrow(/Missing required path parameter/);
    expect(() => buildPath("/api/hosts/:id", JSON.parse('{"__proto__":{"id":"x"}}'))).toThrow(/Missing/);
  });
});

describe("buildRequest", () => {
  it("sends declared GET args as the query and never sends path params there", () => {
    const request = buildRequest({ method: "GET", path: "/api/hosts/:id/power" }, { id: "h1", timeout: 5 }, "https://f.test.invalid");
    expect(request.url).toBe("https://f.test.invalid/api/hosts/h1/power?timeout=5");
    expect(request.body).toBeUndefined();
  });

  it("sends the remaining args as the body and never repeats path params in it", () => {
    const request = buildRequest({ method: "PUT", path: "/api/hosts/:id/boot" }, { id: "h1", device: "pxe" }, "https://f.test.invalid");
    expect(request.url).toBe("https://f.test.invalid/api/hosts/h1/boot");
    expect(JSON.parse(request.body ?? "")).toEqual({ device: "pxe" });
  });

  it("sends no body for DELETE without extra args and a body for bulk delete", () => {
    expect(buildRequest({ method: "DELETE", path: "/api/hosts/:id" }, { id: "h1" }, "https://f.test.invalid").body).toBeUndefined();
    const bulk = buildRequest({ method: "DELETE", path: "/api/hosts/bulk" }, { included: { ids: [1, 2] } }, "https://f.test.invalid");
    expect(JSON.parse(bulk.body ?? "")).toEqual({ included: { ids: [1, 2] } });
  });

  it("drops prototype-pollution keys at every depth", () => {
    const args = JSON.parse('{"host":{"name":"n","__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"ok":1}},"__proto__":{"top":1}}');
    const request = buildRequest({ method: "POST", path: "/api/hosts" }, args, "https://f.test.invalid");
    expect(request.body).not.toContain("__proto__");
    expect(request.body).not.toContain("constructor");
    expect(JSON.parse(request.body ?? "")).toEqual({ host: { name: "n", nested: { ok: 1 } } });
  });
});

describe("response hardening", () => {
  const run = () => executeForemanRequest({ method: "GET", path: "/api/x" }, {}, { credentials: CREDS });

  it("rejects early on a large Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } })));
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("response is too large");
  });

  it("cancels a streamed body that exceeds the cap", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk);
        else controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("response is too large");
    expect(sent).toBeLessThan(20);
  });

  it("redacts settings, parameters and sensitive keys but not harmless ones", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      results: [
        { id: 1, name: "root_pass", value: "hunter2-fake", default: "d-fake" },
        { id: 2, name: "login_text", value: "welcome" },
      ],
      parameters: [{ name: "ssh_key", value: "ssh-rsa FAKE" }, { name: "ntp_server", value: "pool.ntp.org" }],
      host: { id: 3, host_id: 4, keyboard: "us", monkey: "x", root_pass: "fake-root", api_key: "fake-k", sshKey: "fake", private_key: "fake" },
    })));
    const result = await run();
    expect(result).toEqual({
      ok: true,
      data: {
        results: [
          { id: 1, name: "root_pass", value: "[REDACTED]", default: "[REDACTED]" },
          { id: 2, name: "login_text", value: "welcome" },
        ],
        parameters: [{ name: "ssh_key", value: "[REDACTED]" }, { name: "ntp_server", value: "pool.ntp.org" }],
        host: { id: 3, host_id: 4, keyboard: "us", monkey: "x", root_pass: "[REDACTED]", api_key: "[REDACTED]", sshKey: "[REDACTED]", private_key: "[REDACTED]" },
      },
    });
  });

  it("surfaces the network error cause and a CA hint for TLS failures", async () => {
    const tls = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
    vi.stubGlobal("fetch", vi.fn(async () => { throw tls; }));
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.message).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
      expect(result.error.message).toContain("FOREMAN_CA_CERT_FILE");
    }
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
    vi.stubGlobal("fetch", vi.fn(async () => { throw refused; }));
    const r2 = await run();
    if (!r2.ok) {
      expect(r2.error.message).toContain("ECONNREFUSED");
      expect(r2.error.message).not.toContain("FOREMAN_CA_CERT_FILE");
    }
  });
});

describe("executeForemanRequest", () => {
  it("sends Basic auth, the version 2 Accept header and the declared body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ host: { id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest({ method: "POST", path: "/api/hosts" }, { host: { name: "test-host" } }, { credentials: CREDS });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://foreman.test.invalid/api/hosts");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("foreman-user:fake-pat-for-tests").toString("base64")}`);
    expect(headers.Accept).toBe("application/json,version=2");
    expect(JSON.parse(String(init.body))).toEqual({ host: { name: "test-host" } });
  });

  it("returns list responses as-is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ total: 1, results: [{ id: 1, name: "web01" }] })));
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(result).toEqual({ ok: true, data: { total: 1, results: [{ id: 1, name: "web01" }] } });
  });

  it("returns a config error when no base URL is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("FOREMAN_BASE_URL is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 302, headers: { Location: "https://elsewhere.test.invalid" } })));
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/redirect/);
  });

  it("makes exactly one upstream call when the API always answers 401 (no retry loop)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "Unable to authenticate user" } }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("auth");
      expect(result.error.message).toContain("HTTP 401: Unable to authenticate user");
      expect(result.error.message).toContain("Personal Access Token");
    }
    const forbidden = vi.fn(async () => jsonResponse({ error: { message: "Forbidden" } }, 403));
    vi.stubGlobal("fetch", forbidden);
    const denied = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(forbidden).toHaveBeenCalledTimes(1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.kind).toBe("auth");
      expect(denied.error.message).toContain("HTTP 403: Forbidden");
      expect(denied.error.message).toContain("lacks permission");
      expect(denied.error.message).not.toContain("Personal Access Token");
    }
  });

  it("surfaces the Foreman error message, in each of its shapes", async () => {
    const cases: Array<[unknown, string]> = [
      [{ error: { message: "Host not found", full_messages: ["Host not found"] } }, "Host not found"],
      [{ error: "Unknown power action" }, "Unknown power action"],
      [{ error: { full_messages: ["Name is taken", "Mac is invalid"] } }, "Name is taken; Mac is invalid"],
    ];
    for (const [body, expected] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 422)));
      const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe(`Foreman API returned HTTP 422: ${expected}`);
    }
  });

  it("redacts the token, Basic auth value and derived forms from errors", async () => {
    const basic = Buffer.from("foreman-user:fake-pat-for-tests").toString("base64");
    const message = `bad request: token fake-pat-for-tests, Authorization: Basic ${basic}, b64 ${basic}, ${encodeURIComponent("fake-pat-for-tests")}`;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message } }, 500)));
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("fake-pat-for-tests");
      expect(result.error.message).not.toContain(basic);
      expect(result.error.message).toContain("[REDACTED]");
    }
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("request failed for token fake-pat-for-tests");
    }));
    const network = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.error.message).not.toContain("fake-pat-for-tests");
  });

  it("redacts successful responses (secret values and sensitive keys)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      host: { name: "web01", root_pass: "fake-root-pass", comment: "uses fake-pat-for-tests", interfaces: [{ password: "fake-bmc-pass", identifier: "eth0" }], compliance: "ok", bypass: "keep" },
    })));
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts/web01" }, { id: "web01" }, { credentials: CREDS });
    expect(result.ok).toBe(true);
    const text = JSON.stringify(result.ok ? result.data : null);
    expect(text).not.toContain("fake-root-pass");
    expect(text).not.toContain("fake-bmc-pass");
    expect(text).not.toContain("fake-pat-for-tests");
    expect(text).toContain("web01");
    expect(text).toContain("eth0");
    expect(text).toContain("keep");
  });
});

describe("redact before truncate", () => {
  it("never shows a secret that straddles the truncation boundary", () => {
    const secret = "fake-straddling-secret-value";
    const text = "a".repeat(MAX_MESSAGE_CHARS - 10) + secret + "tail";
    const out = redactAndTruncate(text, [secret]);
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(out).not.toContain(secret.slice(0, 6));
    expect(out).not.toContain("straddling");
    // Truncating first would have left a visible prefix of the secret:
    expect(text.slice(0, MAX_MESSAGE_CHARS)).toContain(secret.slice(0, 6));
  });

  it("applies to a real upstream error body end to end", async () => {
    const padding = "x".repeat(MAX_MESSAGE_CHARS - 40);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: `${padding}${CREDS.token}-and-more` } }, 500)));
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
      expect(result.error.message).not.toContain("fake-pat");
    }
  });

  it("redactData handles nested values", () => {
    expect(redactData({ a: ["tok-abc-fake"], b: { c: "x tok-abc-fake y" } }, ["tok-abc-fake"])).toEqual({ a: ["[REDACTED]"], b: { c: "x [REDACTED] y" } });
  });
});

describe("CA certificate agent", () => {
  it("is absent when FOREMAN_CA_CERT_FILE is unset and cached per path otherwise", () => {
    expect(getAgent({})).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "foreman-ca-"));
    const a = join(dir, "a.pem");
    const b = join(dir, "b.pem");
    writeFileSync(a, "not-a-real-ca\n");
    writeFileSync(b, "not-a-real-ca-either\n");
    const first = getAgent({ FOREMAN_CA_CERT_FILE: a });
    expect(first).toBeDefined();
    expect(getAgent({ FOREMAN_CA_CERT_FILE: a })).toBe(first);
    expect(getAgent({ FOREMAN_CA_CERT_FILE: b })).not.toBe(first);
  });

  it("reports an unreadable CA file as a config error without calling upstream", async () => {
    process.env.FOREMAN_CA_CERT_FILE = "/nonexistent/ca.pem";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: CREDS });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("config");
      expect(result.error.message).toContain("(ENOENT)");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
