import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callForemanTool } from "../utils/handler.js";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL };
  process.env.FOREMAN_USERNAME = "foreman-user";
  process.env.FOREMAN_TOKEN = "foreman-token";
  delete process.env.FOREMAN_TOOL_TIERS;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe("Foreman handler", () => {
  it("executes a mocked read tool end to end", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ host: { id: 7, name: "foreman-test" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callForemanTool("foreman_host_get", { id: "foreman-test" });
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ host: { id: 7, name: "foreman-test" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://foreman.example.com/api/hosts/foreman-test");
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json,version=2");
  });
});
