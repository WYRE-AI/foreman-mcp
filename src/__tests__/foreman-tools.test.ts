import { describe, expect, it } from "vitest";
import { FOREMAN_ENDPOINTS } from "../tools/registry.js";
import { TOOL_TIERS } from "../tool-tiers.js";
import { getEnabledTiers } from "../tiers.js";

describe("Foreman tool registry", () => {
  it("exposes one tool for each authoritative Foreman endpoint", () => {
    expect(FOREMAN_ENDPOINTS).toHaveLength(72);
    expect(new Set(FOREMAN_ENDPOINTS.map((endpoint) => endpoint.toolName)).size).toBe(72);
  });

  it("reports 47 read, 18 write, and 7 admin tools", () => {
    const counts = { read: 0, write: 0, admin: 0 };
    for (const endpoint of FOREMAN_ENDPOINTS) counts[endpoint.tier] += 1;
    expect(counts).toEqual({ read: 47, write: 18, admin: 7 });
  });

  it("gives every tool a tier and required destructive warning for admin tools", () => {
    for (const endpoint of FOREMAN_ENDPOINTS) {
      expect(TOOL_TIERS[endpoint.toolName]).toBeDefined();
      expect(TOOL_TIERS[endpoint.toolName].tier).toBe(endpoint.tier);
      if (endpoint.tier === "admin") {
        expect(endpoint.description).toMatch(/⚠/);
        expect(endpoint.description).toMatch(/DESTRUCTIVE|HIGH-IMPACT/);
      }
    }
    expect(getEnabledTiers({}).size).toBe(1);
  });
});
