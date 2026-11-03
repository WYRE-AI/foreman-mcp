import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeForemanRequest, getBaseUrl, resolveBaseUrl } from "../utils/client.js";
import { getCredentials } from "../utils/client.js";

const ORIGINAL = { ...process.env };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  delete process.env.FOREMAN_BASE_URL;
  delete process.env.FOREMAN_USERNAME;
  delete process.env.FOREMAN_TOKEN;
  delete process.env.FOREMAN_CA_CERT_FILE;
  delete process.env.AUTH_MODE;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Foreman client", () => {
  it("sends Basic auth, version 2 Accept header, JSON content type, and resource key body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ host: { id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest(
      { method: "POST", path: "/api/hosts", resourceKey: "host" },
      { host: { name: "test-host", location_id: 1, organization_id: 1 } },
      { credentials: { username: "foreman-user", token: "foreman-token" } },
    );
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://foreman.example.com/api/hosts");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("foreman-user:foreman-token").toString("base64")}`);
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json,version=2");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ host: { name: "test-host", location_id: 1, organization_id: 1 } });
  });

  it("returns list responses as-is", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ total: 1, subtotal: 1, page: 1, per_page: 20, search: null, results: [{ id: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: { username: "u", token: "t" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ total: 1, subtotal: 1, page: 1, per_page: 20, search: null, results: [{ id: 1 }] });
  });

  it("surfaces Foreman error payloads without echoing credentials", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "Host not found", full_messages: ["Host not found"] } }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts/1" }, { id: "1" }, { credentials: { username: "u", token: "secret-token" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("http");
    if (!result.ok) expect(result.error.message).not.toContain("secret-token");
  });

  it("rejects unsafe base URLs and redacts token-bearing errors", async () => {
    expect(() => resolveBaseUrl("http://foreman.example.com/api")).toThrow(/https/);
    expect(() => resolveBaseUrl("https://evil.example.com/api")).toThrow(/foreman\.example\.com/);
    expect(() => resolveBaseUrl("https://foreman.example.com@evil.com/api")).toThrow();
    const fetchMock = vi.fn(async () => {
      throw new Error("request failed for token secret-token");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeForemanRequest({ method: "GET", path: "/api/hosts" }, {}, { credentials: { username: "u", token: "secret-token" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain("secret-token");
    expect(result.ok).toBe(false);
  });

  it("reads credentials from environment", () => {
    process.env.FOREMAN_USERNAME = "foreman-user";
    process.env.FOREMAN_TOKEN = "foreman-token";
    expect(getCredentials()).toEqual({ username: "foreman-user", token: "foreman-token" });
    expect(getBaseUrl({})).toBe("https://foreman.example.com");
  });
});
