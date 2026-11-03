import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callForemanTool } from "../utils/handler.js";
import { pathParamNames, runWithCredentials } from "../utils/client.js";
import { FOREMAN_ENDPOINTS } from "../tools/registry.js";

const ORIGINAL = { ...process.env };
const BASE = "https://foreman.test.invalid";

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

function mockFetch(body: unknown = { ok: true }, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  process.env.FOREMAN_BASE_URL = BASE;
  process.env.FOREMAN_USERNAME = "foreman-user";
  process.env.FOREMAN_TOKEN = "fake-pat-for-tests";
  process.env.FOREMAN_TOOL_TIERS = "read,write,admin";
  delete process.env.AUTH_MODE;
  delete process.env.FOREMAN_CA_CERT_FILE;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe("Foreman handler", () => {
  it("executes a mocked read tool end to end", async () => {
    const fetchMock = mockFetch({ host: { id: 7, name: "foreman-test" } });
    const result = await callForemanTool("foreman_host_get", { id: "foreman-test" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(textOf(result))).toEqual({ host: { id: 7, name: "foreman-test" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/hosts/foreman-test`);
    expect((init.headers as Record<string, string>).Accept).toBe("application/json,version=2");
  });

  it("sends list arguments as the query string", async () => {
    const fetchMock = mockFetch({ results: [] });
    await callForemanTool("foreman_hosts_list", { search: "name ~ web", per_page: 5 });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${BASE}/api/hosts?search=name+%7E+web&per_page=5`);
  });

  it("never forwards an undeclared argument", async () => {
    const fetchMock = mockFetch();
    for (const [tool, args] of [
      ["foreman_hosts_list", { bogus: "1" }],
      ["foreman_host_get", { id: "h1", bogus: "1" }],
      ["foreman_host_update", { id: "h1", host: { name: "x" }, bogus: "1" }],
      ["foreman_host_delete", { id: "h1", bogus: "1" }],
      ["foreman_status_get", { bogus: "1" }],
    ] as const) {
      const result = await callForemanTool(tool, { ...args });
      expect(result.isError, tool).toBe(true);
      expect(textOf(result)).toContain("bogus");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mail_to on schedule_report as an undeclared argument", async () => {
    const fetchMock = mockFetch();
    const result = await callForemanTool("foreman_report_templates_schedule_report", { id: 1, mail_to: "attacker@example.invalid" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("mail_to");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects __proto__ / constructor arguments and never forwards them", async () => {
    const fetchMock = mockFetch();
    const polluted = JSON.parse('{"id":"h1","__proto__":{"admin":true},"constructor":{"x":1}}');
    const result = await callForemanTool("foreman_host_get", polluted);
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // Nested pollution keys inside a declared object are stripped from the body.
    const nested = JSON.parse('{"host":{"name":"n","__proto__":{"p":1}}}');
    await callForemanTool("foreman_hosts_create", nested);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(String(init.body)).not.toContain("__proto__");
  });

  it("validates required arguments, types and enums", async () => {
    const fetchMock = mockFetch();
    expect((await callForemanTool("foreman_host_get", {})).isError).toBe(true);
    expect((await callForemanTool("foreman_hosts_list", { per_page: "many" })).isError).toBe(true);
    expect((await callForemanTool("foreman_host_boot", { id: "h1", device: "floppy" })).isError).toBe(true);
    expect((await callForemanTool("foreman_host_power", { id: "h1" })).isError).toBe(true);
    expect((await callForemanTool("foreman_host_get", [] as unknown as Record<string, unknown>)).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe path parameter values before any request", async () => {
    const fetchMock = mockFetch();
    for (const id of ["..", ".", "a/b", "..%2f", "a\\b", "", "a\nb"]) {
      const result = await callForemanTool("foreman_host_get", { id });
      if (id === "..%2f") {
        // Percent signs are data, not an escape: encoded again, never decoded.
        expect(result.isError).toBe(false);
      } else {
        expect(result.isError, JSON.stringify(id)).toBe(true);
      }
    }
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${BASE}/api/hosts/..%252f`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send path parameters in the query or body", async () => {
    const fetchMock = mockFetch();
    await callForemanTool("foreman_host_boot", { id: "h1", device: "pxe" });
    await callForemanTool("foreman_host_power_get", { id: "h1" });
    const [, boot] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(boot.body))).toEqual({ device: "pxe" });
    const [powerUrl] = fetchMock.mock.calls[1] as unknown as [string];
    expect(powerUrl).toBe(`${BASE}/api/hosts/h1/power`);
  });

  it("sends the declared fields of write tools exactly as Foreman expects", async () => {
    const fetchMock = mockFetch();
    await callForemanTool("foreman_host_power", { id: "h1", power_action: "reboot" });
    await callForemanTool("foreman_host_disassociate", { id: "h1" });
    await callForemanTool("foreman_host_rebuild_config", { id: "h1" });
    await callForemanTool("foreman_hostgroups_clone", { id: 4, name: "copy" });
    await callForemanTool("foreman_hosts_bulk_delete", { included: { ids: [1] } });
    const bodies = fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].body);
    expect(bodies.map((b) => (b === undefined ? undefined : JSON.parse(String(b))))).toEqual([
      { power_action: "reboot" },
      {},
      {},
      { name: "copy" },
      { included: { ids: [1] } },
    ]);
  });

  it("accepts numeric ids as digit strings for number-typed path params", async () => {
    const fetchMock = mockFetch();
    expect((await callForemanTool("foreman_hostgroup_get", { id: "12" })).isError).toBe(false);
    expect((await callForemanTool("foreman_hostgroup_get", { id: "abc" })).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds every path from the raw template for ALL tools with path params", async () => {
    const fetchMock = mockFetch();
    const withParams = FOREMAN_ENDPOINTS.filter((endpoint) => pathParamNames(endpoint.path).length > 0);
    expect(withParams.length).toBeGreaterThan(20);
    for (const endpoint of withParams) {
      fetchMock.mockClear();
      const names = pathParamNames(endpoint.path);
      const values: Record<string, string> = {};
      for (const name of names) values[name] = `value ${name}`;
      const args: Record<string, unknown> = {};
      for (const name of names) args[name] = endpoint.inputSchema.properties[name].type === "number" ? 41 : values[name];
      for (const required of endpoint.inputSchema.required) {
        if (args[required] === undefined) {
          const type = endpoint.inputSchema.properties[required].type;
          args[required] = type === "object" ? { k: "v" } : type === "string" ? (endpoint.inputSchema.properties[required].enum?.[0] ?? "s") : 1;
        }
      }
      const result = await callForemanTool(endpoint.toolName, args);
      expect(result.isError, `${endpoint.toolName}: ${textOf(result)}`).toBe(false);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const path = new URL(url).pathname;
      // Independent expectation: segment-wise substitution.
      const expected = endpoint.path
        .split("/")
        .map((segment) => (segment.startsWith(":") ? encodeURIComponent(String(args[segment.slice(1)])) : segment))
        .join("/");
      expect(path, endpoint.toolName).toBe(expected);
      expect(path, endpoint.toolName).not.toMatch(/[:{}]/);
      expect(url).not.toMatch(/%7B|%7D|:[a-z_]+(\/|$)/);
      // Path params are in the path only.
      for (const name of names) {
        expect(new URL(url).searchParams.has(name)).toBe(false);
        if (init.body) expect(Object.keys(JSON.parse(String(init.body)))).not.toContain(name);
      }
    }
  });
});

describe("configuration and auth failures return is_error", () => {
  it("returns is_error with the base-URL message on every tool when FOREMAN_BASE_URL is unset", async () => {
    delete process.env.FOREMAN_BASE_URL;
    const fetchMock = mockFetch();
    for (const endpoint of FOREMAN_ENDPOINTS.slice(0, 10)) {
      const result = await callForemanTool(endpoint.toolName, {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("FOREMAN_BASE_URL is required");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns is_error without credentials", async () => {
    delete process.env.FOREMAN_TOKEN;
    mockFetch();
    const result = await callForemanTool("foreman_hosts_list", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/credentials/i);
  });

  it("gateway mode with no scoped credentials is is_error even when env credentials exist", async () => {
    process.env.AUTH_MODE = "gateway";
    const fetchMock = mockFetch();
    const result = await callForemanTool("foreman_hosts_list", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("gateway mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gateway mode uses only the per-request credentials", async () => {
    process.env.AUTH_MODE = "gateway";
    const fetchMock = mockFetch({ results: [] });
    const result = await runWithCredentials({ username: "gw-user", token: "gw-fake-token", baseUrl: BASE }, () => callForemanTool("foreman_hosts_list", {}));
    expect(result.isError).toBe(false);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("gw-user:gw-fake-token").toString("base64")}`);
  });

  it("does not list or run tools outside the enabled tiers", async () => {
    process.env.FOREMAN_TOOL_TIERS = "read";
    const fetchMock = mockFetch();
    const result = await callForemanTool("foreman_host_delete", { id: "h1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("admin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a 401 once", async () => {
    const fetchMock = mockFetch({ error: { message: "Unable to authenticate" } }, 401);
    const result = await callForemanTool("foreman_hosts_list", {});
    expect(result.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
