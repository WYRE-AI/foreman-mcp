import type { ForemanEndpoint, ParamSchema } from "../utils/types.js";

const STR: ParamSchema = { type: "string" };
const NUM: ParamSchema = { type: "number" };
const BOOL: ParamSchema = { type: "boolean" };
const OBJ: ParamSchema = { type: "object" };

const BOOT_DEVICES = ["disk", "cdrom", "pxe", "bios"] as const;
const POWER_ACTIONS = ["on", "start", "off", "stop", "reboot", "reset", "soft", "cycle", "state", "status"] as const;
const BULK_POWER_ACTIONS = ["start", "stop", "poweroff", "reboot", "reset", "soft", "cycle"] as const;

const BULK_INCLUDED: ParamSchema = {
  type: "object",
  description: "Hosts to act on: { search?: scoped-search string, ids?: host id array }.",
};
const BULK_EXCLUDED: ParamSchema = {
  type: "object",
  description: "Hosts to leave out: { ids?: host id array }.",
};

/** Standard Foreman list parameters, plus any tool-specific ones. */
function listSchema(extra: Record<string, ParamSchema> = {}, required: string[] = []): InputSchemaInput {
  return {
    type: "object",
    properties: {
      ...extra,
      search: { type: "string", description: "Foreman scoped-search query." },
      order: { type: "string", description: "Sort field and direction, e.g. `name DESC`." },
      page: { type: "integer", minimum: 1 },
      per_page: { type: "integer", minimum: 1 },
    },
    required,
  };
}

type InputSchemaInput = { type: "object"; properties?: Record<string, ParamSchema>; required?: string[] };

/** Every tool gets a closed schema: declared properties only. */
function createEndpoint(
  toolName: string,
  method: ForemanEndpoint["method"],
  path: string,
  tier: ForemanEndpoint["tier"],
  description: string,
  inputSchema: InputSchemaInput,
): ForemanEndpoint {
  return {
    toolName,
    method,
    path,
    tier,
    description,
    inputSchema: {
      type: "object",
      properties: inputSchema.properties ?? {},
      required: inputSchema.required ?? [],
      additionalProperties: false,
    },
  };
}

export const FOREMAN_ENDPOINTS: readonly ForemanEndpoint[] = [
  createEndpoint("foreman_status_get", "GET", "/api/status", "read", "Get Foreman service status.", { type: "object" }),
  createEndpoint("foreman_ping_get", "GET", "/api/ping", "read", "Ping the Foreman API.", { type: "object" }),
  createEndpoint("foreman_statuses_list", "GET", "/api/statuses", "read", "List Foreman statuses.", listSchema()),
  createEndpoint("foreman_current_user_get", "GET", "/api/current_user", "read", "Get the current Foreman user.", { type: "object" }),
  createEndpoint("foreman_dashboard_get", "GET", "/api/dashboard", "read", "Get Foreman dashboard summary.", { type: "object" }),
  createEndpoint("foreman_hosts_list", "GET", "/api/hosts", "read", "List Foreman hosts.", listSchema()),
  createEndpoint("foreman_host_get", "GET", "/api/hosts/:id", "read", "Get a Foreman host by ID or FQDN.", { type: "object", properties: { id: STR }, required: ["id"] }),
  createEndpoint("foreman_host_status_get", "GET", "/api/hosts/:id/status/:type", "read", "Get a Foreman host status.", { type: "object", properties: { id: STR, type: STR }, required: ["id", "type"] }),
  createEndpoint("foreman_host_power_get", "GET", "/api/hosts/:id/power", "read", "Get Foreman host power state (VMs and hosts with a BMC).", { type: "object", properties: { id: STR, timeout: { type: "integer", minimum: 1, description: "Seconds to wait for the power state (Foreman default 3)." } }, required: ["id"] }),
  createEndpoint("foreman_host_power", "PUT", "/api/hosts/:id/power", "write", "⚠ HIGH-IMPACT — affects a real machine: starts, stops, reboots, resets or power-cycles the host (power_action `state`/`status` only reads the state). This can disrupt running workloads.", { type: "object", properties: { id: STR, power_action: { type: "string", enum: POWER_ACTIONS, description: "Power action." } }, required: ["id", "power_action"] }),
  createEndpoint("foreman_host_inherited_parameters_get", "GET", "/api/hosts/:id/inherited_parameters", "read", "Get inherited Foreman host parameters.", { type: "object", properties: { id: STR }, required: ["id"] }),
  createEndpoint("foreman_host_vm_compute_attributes_get", "GET", "/api/hosts/:id/vm_compute_attributes", "read", "Get virtual machine compute attributes for a Foreman host.", { type: "object", properties: { id: STR }, required: ["id"] }),
  createEndpoint("foreman_host_facts_list", "GET", "/api/hosts/:host_id/facts", "read", "List facts for a Foreman host.", listSchema({ host_id: STR }, ["host_id"])),
  createEndpoint("foreman_host_interfaces_list", "GET", "/api/hosts/:host_id/interfaces", "read", "List network interfaces for a Foreman host.", listSchema({ host_id: STR }, ["host_id"])),
  createEndpoint("foreman_host_interface_get", "GET", "/api/hosts/:host_id/interfaces/:id", "read", "Get a network interface for a Foreman host.", { type: "object", properties: { host_id: STR, id: STR }, required: ["host_id", "id"] }),
  createEndpoint("foreman_host_config_reports_last_get", "GET", "/api/hosts/:host_id/config_reports/last", "read", "Get the latest Foreman host configuration report.", { type: "object", properties: { host_id: STR }, required: ["host_id"] }),
  createEndpoint("foreman_host_audits_list", "GET", "/api/hosts/:host_id/audits", "read", "List audits for a Foreman host.", listSchema({ host_id: STR }, ["host_id"])),
  createEndpoint("foreman_host_statuses_list", "GET", "/api/host_statuses", "read", "List Foreman host statuses.", { type: "object" }),
  createEndpoint("foreman_hostgroups_list", "GET", "/api/hostgroups", "read", "List Foreman host groups.", listSchema()),
  createEndpoint("foreman_hostgroup_get", "GET", "/api/hostgroups/:id", "read", "Get a Foreman host group by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_config_reports_list", "GET", "/api/config_reports", "read", "List Foreman configuration reports.", listSchema()),
  createEndpoint("foreman_config_report_get", "GET", "/api/config_reports/:id", "read", "Get a Foreman configuration report by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_audits_list", "GET", "/api/audits", "read", "List Foreman audits.", listSchema()),
  createEndpoint("foreman_audit_get", "GET", "/api/audits/:id", "read", "Get a Foreman audit by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_fact_values_list", "GET", "/api/fact_values", "read", "List Foreman fact values.", listSchema()),
  createEndpoint("foreman_organizations_list", "GET", "/api/organizations", "read", "List Foreman organizations.", listSchema()),
  createEndpoint("foreman_organization_get", "GET", "/api/organizations/:id", "read", "Get a Foreman organization by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_locations_list", "GET", "/api/locations", "read", "List Foreman locations.", listSchema()),
  createEndpoint("foreman_location_get", "GET", "/api/locations/:id", "read", "Get a Foreman location by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_domains_list", "GET", "/api/domains", "read", "List Foreman domains.", listSchema()),
  createEndpoint("foreman_domain_get", "GET", "/api/domains/:id", "read", "Get a Foreman domain by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_subnets_list", "GET", "/api/subnets", "read", "List Foreman subnets.", listSchema()),
  createEndpoint("foreman_subnet_get", "GET", "/api/subnets/:id", "read", "Get a Foreman subnet by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_subnet_freeip_get", "GET", "/api/subnets/:id/freeip", "read", "Get a free IP address for a Foreman subnet.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_operatingsystems_list", "GET", "/api/operatingsystems", "read", "List Foreman operating systems.", listSchema()),
  createEndpoint("foreman_operatingsystem_get", "GET", "/api/operatingsystems/:id", "read", "Get a Foreman operating system by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_smart_proxies_list", "GET", "/api/smart_proxies", "read", "List Foreman smart proxies.", listSchema()),
  createEndpoint("foreman_smart_proxy_get", "GET", "/api/smart_proxies/:id", "read", "Get a Foreman smart proxy by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_compute_resources_list", "GET", "/api/compute_resources", "read", "List Foreman compute resources.", listSchema()),
  createEndpoint("foreman_compute_resource_get", "GET", "/api/compute_resources/:id", "read", "Get a Foreman compute resource by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_compute_resource_virtual_machines_list", "GET", "/api/compute_resources/:id/available_virtual_machines", "read", "List virtual machines available on a Foreman compute resource.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_users_list", "GET", "/api/users", "read", "List Foreman users.", listSchema()),
  createEndpoint("foreman_user_get", "GET", "/api/users/:id", "read", "Get a Foreman user by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_settings_list", "GET", "/api/settings", "read", "List Foreman settings.", listSchema()),
  createEndpoint("foreman_setting_get", "GET", "/api/settings/:id", "read", "Get a Foreman setting by name (for example `login_text`).", { type: "object", properties: { id: STR }, required: ["id"] }),
  createEndpoint("foreman_report_templates_list", "GET", "/api/report_templates", "read", "List Foreman report templates.", listSchema()),
  createEndpoint("foreman_report_template_get", "GET", "/api/report_templates/:id", "read", "Get a Foreman report template by ID.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_report_template_report_data_get", "GET", "/api/report_templates/:id/report_data/:job_id", "read", "Get generated report data for a Foreman report template job.", { type: "object", properties: { id: NUM, job_id: STR }, required: ["id", "job_id"] }),
  // ---- write tier ---------------------------------------------------------
  createEndpoint("foreman_hosts_create", "POST", "/api/hosts", "write", "Create a Foreman host. `host` is the Foreman host attributes object (name, hostgroup_id, location_id, organization_id, ...).", { type: "object", properties: { host: OBJ }, required: ["host"] }),
  createEndpoint("foreman_host_update", "PUT", "/api/hosts/:id", "write", "Update a Foreman host. `host` is the object of host attributes to change.", { type: "object", properties: { id: STR, host: OBJ }, required: ["id", "host"] }),
  createEndpoint("foreman_host_boot", "PUT", "/api/hosts/:id/boot", "write", "⚠ HIGH-IMPACT — affects a real machine: boots the host from the given device through its BMC (IPMI).", { type: "object", properties: { id: STR, device: { type: "string", enum: BOOT_DEVICES, description: "Boot device." } }, required: ["id", "device"] }),
  createEndpoint("foreman_host_rebuild_config", "PUT", "/api/hosts/:id/rebuild_config", "write", "Rebuild a Foreman host's orchestration config (DHCP, DNS, TFTP, ...) from its current provisioning state. Takes no body other than an optional step filter.", { type: "object", properties: { id: STR, only: { type: "array", items: { type: "string" }, description: "Limit the rebuild to these steps." } }, required: ["id"] }),
  createEndpoint("foreman_host_disassociate", "PUT", "/api/hosts/:id/disassociate", "write", "Disassociate a Foreman host from its virtual machine on the compute resource (the VM itself is not deleted).", { type: "object", properties: { id: STR }, required: ["id"] }),
  createEndpoint("foreman_hosts_bulk_reassign_hostgroups", "PUT", "/api/hosts/bulk/reassign_hostgroups", "write", "Reassign the selected hosts to a Foreman host group (omit hostgroup_id to clear it).", { type: "object", properties: { included: BULK_INCLUDED, excluded: BULK_EXCLUDED, hostgroup_id: NUM }, required: ["included"] }),
  createEndpoint("foreman_hosts_bulk_change_power_state", "PUT", "/api/hosts/bulk/change_power_state", "write", "⚠ HIGH-IMPACT — affects real machines: changes the power state (start, stop, reboot, ...) of every selected host.", { type: "object", properties: { included: BULK_INCLUDED, excluded: BULK_EXCLUDED, power: { type: "string", enum: BULK_POWER_ACTIONS, description: "Power action." } }, required: ["included", "power"] }),
  createEndpoint("foreman_hostgroups_create", "POST", "/api/hostgroups", "write", "Create a Foreman host group. `hostgroup` is the object of host group attributes.", { type: "object", properties: { hostgroup: OBJ }, required: ["hostgroup"] }),
  createEndpoint("foreman_hostgroup_update", "PUT", "/api/hostgroups/:id", "write", "Update a Foreman host group. `hostgroup` is the object of attributes to change.", { type: "object", properties: { id: NUM, hostgroup: OBJ }, required: ["id", "hostgroup"] }),
  createEndpoint("foreman_hostgroups_clone", "POST", "/api/hostgroups/:id/clone", "write", "Clone a Foreman host group under a new name.", { type: "object", properties: { id: NUM, name: { type: "string", description: "Name of the new host group." } }, required: ["id", "name"] }),
  createEndpoint("foreman_host_interfaces_create", "POST", "/api/hosts/:host_id/interfaces", "write", "Create a network interface on a Foreman host. `interface` is the interface attributes object.", { type: "object", properties: { host_id: STR, interface: OBJ }, required: ["host_id", "interface"] }),
  createEndpoint("foreman_host_interface_update", "PUT", "/api/hosts/:host_id/interfaces/:id", "write", "Update a network interface on a Foreman host. `interface` is the object of attributes to change.", { type: "object", properties: { host_id: STR, id: STR, interface: OBJ }, required: ["host_id", "id", "interface"] }),
  createEndpoint("foreman_smart_proxies_refresh", "PUT", "/api/smart_proxies/:id/refresh", "write", "Refresh the features of a Foreman smart proxy.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_report_templates_schedule_report", "POST", "/api/report_templates/:id/schedule_report", "write", "Schedule generation of a Foreman report; returns a job id for foreman_report_template_report_data_get.", { type: "object", properties: { id: NUM, input_values: OBJ, gzip: BOOL, generate_at: { type: "string", description: "UTC time to generate the report at." }, report_format: STR }, required: ["id"] }),
  createEndpoint("foreman_report_templates_generate", "POST", "/api/report_templates/:id/generate", "write", "Generate a Foreman report from a template.", { type: "object", properties: { id: NUM, input_values: OBJ, gzip: BOOL, report_format: STR }, required: ["id"] }),
  // ---- admin tier: irreversible actions and access/permission changes -----
  createEndpoint("foreman_hosts_bulk_build", "PUT", "/api/hosts/bulk/build", "admin", "⚠ DESTRUCTIVE — IRREVERSIBLE [admin] Mark the selected hosts to be rebuilt (reprovisioned) on their next boot. The OS reinstall wipes the hosts' disks; it is not undoable once a host boots.", { type: "object", properties: { included: BULK_INCLUDED, excluded: BULK_EXCLUDED, reboot: { type: "boolean", description: "Reboot the hosts after marking them (they are rebuilt immediately). Ignored if rebuild_configuration is true." }, rebuild_configuration: { type: "boolean", description: "Only rebuild orchestration config instead of reprovisioning." } }, required: ["included"] }),
  createEndpoint("foreman_hosts_bulk_change_owner", "PUT", "/api/hosts/bulk/change_owner", "admin", "⚠ HIGH-IMPACT [admin] Change the owner (user or user group) of the selected hosts, which changes who can manage them.", { type: "object", properties: { included: BULK_INCLUDED, excluded: BULK_EXCLUDED, owner_id: NUM }, required: ["included", "owner_id"] }),
  createEndpoint("foreman_host_delete", "DELETE", "/api/hosts/:id", "admin", "⚠ DESTRUCTIVE — IRREVERSIBLE [admin] DELETE a Foreman host. This permanently deletes the host record and can destroy the real machine on a compute resource.", { type: "object", properties: { id: STR }, required: ["id"] }),
  createEndpoint("foreman_hosts_bulk_delete", "DELETE", "/api/hosts/bulk", "admin", "⚠ DESTRUCTIVE — IRREVERSIBLE [admin] DELETE multiple Foreman hosts in bulk (selected with `included`, minus `excluded`).", { type: "object", properties: { included: BULK_INCLUDED, excluded: BULK_EXCLUDED }, required: ["included"] }),
  createEndpoint("foreman_hostgroup_delete", "DELETE", "/api/hostgroups/:id", "admin", "⚠ DESTRUCTIVE — IRREVERSIBLE [admin] DELETE a Foreman host group.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_host_interface_delete", "DELETE", "/api/hosts/:host_id/interfaces/:id", "admin", "⚠ DESTRUCTIVE — IRREVERSIBLE [admin] DELETE a network interface from a Foreman host.", { type: "object", properties: { host_id: STR, id: STR }, required: ["host_id", "id"] }),
  createEndpoint("foreman_host_status_delete", "DELETE", "/api/hosts/:id/status/:type", "admin", "⚠ HIGH-IMPACT [admin] Clear one sub-status record of a Foreman host (it is recomputed on the next report).", { type: "object", properties: { id: STR, type: STR }, required: ["id", "type"] }),
  createEndpoint("foreman_config_report_delete", "DELETE", "/api/config_reports/:id", "admin", "⚠ DESTRUCTIVE — IRREVERSIBLE [admin] DELETE a Foreman configuration report.", { type: "object", properties: { id: NUM }, required: ["id"] }),
  createEndpoint("foreman_setting_update", "PUT", "/api/settings/:id", "admin", "⚠ HIGH-IMPACT [admin] Update a Foreman setting by name. Settings include authentication and access-control settings, so a change can affect every user.", { type: "object", properties: { id: STR, setting: OBJ }, required: ["id", "setting"] }),
];
