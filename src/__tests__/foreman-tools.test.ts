import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FOREMAN_ENDPOINTS } from "../tools/registry.js";
import { TOOL_TIERS } from "../tool-tiers.js";
import { getEnabledTiers } from "../tiers.js";
import { pathParamNames } from "../utils/client.js";

const counts = () => {
  const result = { read: 0, write: 0, admin: 0 };
  for (const endpoint of FOREMAN_ENDPOINTS) result[endpoint.tier] += 1;
  return result;
};

describe("Foreman tool registry", () => {
  it("exposes one unique tool for each authoritative Foreman endpoint", () => {
    expect(FOREMAN_ENDPOINTS).toHaveLength(72);
    expect(new Set(FOREMAN_ENDPOINTS.map((endpoint) => endpoint.toolName)).size).toBe(72);
    expect(new Set(FOREMAN_ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).size).toBe(72);
  });

  it("reports 47 read, 16 write, and 9 admin tools", () => {
    expect(counts()).toEqual({ read: 47, write: 16, admin: 9 });
  });

  it("keeps schema/tiers.json in sync with the registry", () => {
    const file = JSON.parse(readFileSync(new URL("../../schema/tiers.json", import.meta.url), "utf8")) as Record<string, string>;
    expect(file).toEqual(Object.fromEntries(FOREMAN_ENDPOINTS.map((endpoint) => [endpoint.toolName, endpoint.tier])));
  });

  it("gives every tool a tier, and read tools are GET only", () => {
    for (const endpoint of FOREMAN_ENDPOINTS) {
      expect(TOOL_TIERS[endpoint.toolName].tier).toBe(endpoint.tier);
      if (endpoint.tier === "read") expect(endpoint.method).toBe("GET");
      else expect(endpoint.method).not.toBe("GET");
    }
    expect(getEnabledTiers({}).size).toBe(1);
  });

  it("gives every tool a closed JSON schema whose required/path params are declared", () => {
    for (const endpoint of FOREMAN_ENDPOINTS) {
      const schema = endpoint.inputSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(typeof schema.properties).toBe("object");
      for (const key of schema.required) expect(Object.keys(schema.properties), `${endpoint.toolName}.${key}`).toContain(key);
      for (const name of pathParamNames(endpoint.path)) {
        expect(schema.properties[name], `${endpoint.toolName}:${name}`).toBeDefined();
        expect(schema.required, `${endpoint.toolName}:${name}`).toContain(name);
      }
      for (const key of Object.keys(schema.properties)) expect(["__proto__", "constructor", "prototype"]).not.toContain(key);
    }
  });

  it("matches Foreman's parameters for the write tools that previously drifted", () => {
    const tool = (name: string) => FOREMAN_ENDPOINTS.find((endpoint) => endpoint.toolName === name)!;
    expect(Object.keys(tool("foreman_host_boot").inputSchema.properties).sort()).toEqual(["device", "id"]);
    expect(Object.keys(tool("foreman_host_power").inputSchema.properties).sort()).toEqual(["id", "power_action"]);
    expect(Object.keys(tool("foreman_host_disassociate").inputSchema.properties)).toEqual(["id"]);
    expect(Object.keys(tool("foreman_host_rebuild_config").inputSchema.properties).sort()).toEqual(["id", "only"]);
    expect(Object.keys(tool("foreman_hostgroups_clone").inputSchema.properties).sort()).toEqual(["id", "name"]);
    expect(tool("foreman_hosts_bulk_build").inputSchema.properties).toHaveProperty("included");
    expect(tool("foreman_hosts_bulk_change_owner").inputSchema.required).toEqual(["included", "owner_id"]);
  });
});

describe("tier policy", () => {
  const admin = FOREMAN_ENDPOINTS.filter((endpoint) => endpoint.tier === "admin").map((endpoint) => endpoint.toolName).sort();

  it("keeps admin for irreversible actions and access changes only", () => {
    expect(admin).toEqual([
      "foreman_config_report_delete",
      "foreman_host_delete",
      "foreman_host_interface_delete",
      "foreman_host_status_delete",
      "foreman_hostgroup_delete",
      "foreman_hosts_bulk_build",
      "foreman_hosts_bulk_change_owner",
      "foreman_hosts_bulk_delete",
      "foreman_setting_update",
    ]);
    const tier = (name: string) => FOREMAN_ENDPOINTS.find((endpoint) => endpoint.toolName === name)!.tier;
    expect(tier("foreman_host_power")).toBe("write");
    expect(tier("foreman_hosts_bulk_change_power_state")).toBe("write");
  });

  it("uses a warning prefix on every admin tool, IRREVERSIBLE only where truly irreversible", () => {
    const irreversible = new Set(["foreman_config_report_delete", "foreman_host_delete", "foreman_host_interface_delete", "foreman_hostgroup_delete", "foreman_hosts_bulk_build", "foreman_hosts_bulk_delete"]);
    for (const endpoint of FOREMAN_ENDPOINTS.filter((e) => e.tier === "admin")) {
      if (irreversible.has(endpoint.toolName)) expect(endpoint.description, endpoint.toolName).toMatch(/^⚠ DESTRUCTIVE — IRREVERSIBLE/);
      else {
        expect(endpoint.description, endpoint.toolName).toMatch(/^⚠ HIGH-IMPACT/);
        expect(endpoint.description, endpoint.toolName).not.toMatch(/IRREVERSIBLE/);
      }
    }
    for (const endpoint of FOREMAN_ENDPOINTS.filter((e) => e.tier !== "admin")) expect(endpoint.description).not.toMatch(/IRREVERSIBLE/);
  });

  it("describes power tools as affecting real machines", () => {
    for (const name of ["foreman_host_power", "foreman_host_boot", "foreman_hosts_bulk_change_power_state"]) {
      expect(FOREMAN_ENDPOINTS.find((e) => e.toolName === name)!.description).toMatch(/real machine/);
    }
  });
});
