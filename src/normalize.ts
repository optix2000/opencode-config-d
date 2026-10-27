/** Scoped native config decoding and the supported local V1 fragment migrations. */
import { Config } from "@opencode/schema/config"
import { Schema } from "effect"

export type RecordValue = Record<string, unknown>
export type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/** Normalized values (raw until merged, or decoded) plus declarations outside Config.Info. */
export interface Document<T = Config.Info> {
  readonly config: T
  readonly policies: readonly Rule[]
  readonly mcpActivation: readonly (readonly [string, boolean])[]
}

export const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Merge maps, replace arrays, and replace discriminated unions rather than mixing server types. */
export function mergeConfigValues(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) return structuredClone(right)
  if (left.type && right.type && left.type !== right.type) return structuredClone(right)
  const result = structuredClone(left)
  for (const [key, value] of Object.entries(right)) result[key] = mergeConfigValues(result[key], value)
  return result
}

/** Decode without exposing resolved credentials through Effect's verbose schema diagnostics. */
export function decodeConfig(value: unknown, source = "merged config", strict = false): Config.Info {
  try {
    return Schema.decodeUnknownSync(Config.Info, { onExcessProperty: strict ? "error" : "ignore" })(value)
  } catch {
    throw new Error(`Invalid supported config schema in ${source}`)
  }
}

const actionName = (name: string) => ({ bash: "shell", task: "subagent", patch: "edit", write: "edit" })[name] ?? name
const providerID = (id: string) => ({ "azure-cognitive-services": "azure", "google-vertex-anthropic": "google-vertex" })[id] ?? id
const effect = (value: unknown): value is Rule["effect"] => ["allow", "deny", "ask"].includes(String(value))

/** Preserve rule insertion order; explicit V1 permissions override deprecated tools. */
function legacyPermissions(permission: unknown, tools: unknown): Rule[] {
  const rules: Rule[] = []
  if (isRecord(tools)) for (const [action, enabled] of Object.entries(tools)) {
    if (typeof enabled === "boolean") rules.push({ action: actionName(action), resource: "*", effect: enabled ? "allow" : "deny" })
  }
  if (effect(permission)) rules.push({ action: "*", resource: "*", effect: permission })
  if (isRecord(permission)) for (const [action, value] of Object.entries(permission)) {
    if (effect(value)) rules.push({ action: actionName(action), resource: "*", effect: value })
    else if (isRecord(value)) for (const [resource, item] of Object.entries(value)) {
      if (effect(item)) rules.push({ action: actionName(action), resource, effect: item })
    }
  }
  return rules
}

const NATIVE_AGENT = new Set(["model", "request", "system", "description", "mode", "hidden", "color", "steps", "disabled", "permissions"])
const LEGACY_AGENT = new Set(["name", "model", "variant", "temperature", "top_p", "prompt", "tools", "disable", "description", "mode", "hidden", "options", "color", "steps", "maxSteps", "permission"])

/** Normalize V1 agents without allowing native frontmatter to become opaque request body options. */
function legacyAgent(value: unknown): RecordValue {
  if (!isRecord(value)) throw new Error("Invalid legacy agent: expected an object")
  const body: RecordValue = isRecord(value.options) ? structuredClone(value.options) : {}
  for (const [key, item] of Object.entries(value)) {
    if (!LEGACY_AGENT.has(key) && !NATIVE_AGENT.has(key)) body[key] = item
  }
  if (value.temperature !== undefined) body.temperature = value.temperature
  if (value.top_p !== undefined) body.top_p = value.top_p
  let model = value.model
  if (typeof model === "string") {
    const slash = model.indexOf("/")
    model = `${providerID(model.slice(0, slash))}${model.slice(slash)}`
    if (typeof value.variant === "string") model = `${String(model).split("#")[0]}#${value.variant}`
  } else if (isRecord(model)) {
    model = { providerID: typeof model.providerID === "string" ? providerID(model.providerID) : model.providerID,
      model: model.model ?? model.id, ...(value.variant ?? model.variant ? { variant: value.variant ?? model.variant } : {}) }
  }
  const permissions = legacyPermissions(value.permission, value.tools)
  const result: RecordValue = {
    ...(model !== undefined ? { model } : {}),
    ...(Object.keys(body).length ? { request: { body } } : {}),
    ...(typeof value.prompt === "string" ? { system: value.prompt } : {}),
    ...(value.disable !== undefined ? { disabled: value.disable } : {}),
    ...(value.maxSteps !== undefined ? { steps: value.maxSteps } : {}),
    ...(permissions.length ? { permissions } : {}),
  }
  for (const [key, item] of Object.entries(value)) if (NATIVE_AGENT.has(key) && key !== "model") result[key] = item
  return result
}

/** Select native Markdown frontmatter using native field names, preserving the body as system text. */
export function agentMarkdownDocument(frontmatter: RecordValue, body: string, id: string, primary: boolean): unknown {
  // Any V2-only marker selects the whole file's format; legacy fields must then be ignored.
  const native = ["permissions", "request", "system", "disabled"].some((key) => key in frontmatter) ||
    Object.keys(frontmatter).every((key) => NATIVE_AGENT.has(key))
  const agent = native ? Object.fromEntries(Object.entries(frontmatter).filter(([key]) => NATIVE_AGENT.has(key))) : legacyAgent(frontmatter)
  agent.system = body.trim()
  if (primary) agent.mode = "primary"
  return { agents: { [id]: agent } }
}

const COMPATIBLE_SETTINGS = new Set(["apiKey", "baseURL", "headers", "body", "extraBody", "timeout", "chunkTimeout", "headerTimeout", "disabled", "reasoningEffort", "textVerbosity", "user", "strictJsonSchema"])

/** Split legacy OpenAI-compatible options into supported settings and raw request body fields. */
function modelOptions(value: RecordValue, compatible: boolean): RecordValue {
  if (!compatible) return { settings: value }
  return {
    settings: Object.fromEntries(Object.entries(value).filter(([key]) => COMPATIBLE_SETTINGS.has(key))),
    body: Object.fromEntries(Object.entries(value).filter(([key]) => !COMPATIBLE_SETTINGS.has(key))),
  }
}

/** Convert package names rather than leaving a legacy AI SDK runtime identifier in native config. */
function packageName(value: unknown): unknown {
  return typeof value === "string" && value.startsWith("@ai-sdk/") ? `aisdk:${value}` : value
}

/** Migrate the V1 provider-model fields used by local provider fragments. */
function legacyModel(value: unknown, providerPackage: unknown): RecordValue {
  if (!isRecord(value)) throw new Error("Invalid legacy model: expected an object")
  const result: RecordValue = {}
  for (const key of ["name", "family", "capabilities", "compatibility", "headers", "body", "limit", "settings", "disabled"]) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  const modelProvider = isRecord(value.provider) ? value.provider : {}
  const pkg = modelProvider.npm ?? value.package ?? providerPackage
  if (modelProvider.npm || value.package) result.package = packageName(pkg)
  const compatible = pkg === "@ai-sdk/openai-compatible" || pkg === "aisdk:@ai-sdk/openai-compatible"
  if (isRecord(value.options)) Object.assign(result, modelOptions(value.options, compatible))
  if (modelProvider.api) result.settings = { ...(isRecord(result.settings) ? result.settings : {}), baseURL: modelProvider.api }
  if (value.id !== undefined) result.modelID = value.id
  if (value.modelID !== undefined) result.modelID = value.modelID
  if (value.status === "deprecated") result.disabled = true
  if (value.tool_call !== undefined || isRecord(value.modalities)) {
    const modalities = isRecord(value.modalities) ? value.modalities : {}
    result.capabilities = { ...(isRecord(result.capabilities) ? result.capabilities : {}),
      ...(value.tool_call !== undefined ? { tools: value.tool_call } : {}), ...modalities }
  }
  if (isRecord(value.cost)) {
    const { cache_read, cache_write, ...cost } = value.cost
    result.cost = { ...cost, ...((cache_read !== undefined || cache_write !== undefined)
      ? { cache: { read: cache_read ?? 0, write: cache_write ?? 0 } } : {}) }
  } else if (value.cost !== undefined) result.cost = value.cost
  if (isRecord(value.variants)) result.variants = Object.entries(value.variants).map(([id, options]) => ({
    id, ...(isRecord(options) ? modelOptions(options, compatible) : {}),
  }))
  else if (Array.isArray(value.variants)) result.variants = value.variants
  return result
}

/** Migrate singular V1 providers and model maps; native providers are decoded unchanged. */
function legacyProvider(value: unknown): RecordValue {
  if (!isRecord(value)) throw new Error("Invalid legacy provider: expected an object")
  const result: RecordValue = {}
  for (const key of ["name", "env", "canonical", "compatibility", "settings", "headers", "body"]) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  if (value.npm || value.package) result.package = packageName(value.package ?? value.npm)
  if (isRecord(value.options)) {
    const { headers, body, setCacheKey, ...settings } = value.options
    result.settings = { ...settings, ...(isRecord(result.settings) ? result.settings : {}) }
    if (headers !== undefined) result.headers = headers
    if (body !== undefined) result.body = body
    if (typeof setCacheKey === "boolean") result.compatibility = { supportsPromptCacheKey: setCacheKey }
  }
  if (typeof value.api === "string") result.settings = { ...(isRecord(result.settings) ? result.settings : {}), baseURL: value.api }
  if (isRecord(value.models)) result.models = Object.fromEntries(Object.entries(value.models)
    .map(([id, model]) => [id, legacyModel(model, value.npm ?? value.package)]))
  return result
}

/** Keep native MCP entries authoritative when native and V1 entries share a name. */
function normalizeMCP(raw: unknown): { config?: RecordValue; activation: Array<readonly [string, boolean]> } {
  if (raw === undefined) return { activation: [] }
  if (!isRecord(raw)) throw new Error("Invalid mcp: expected an object")
  const servers: RecordValue = {}
  const states = new Map<string, boolean>()
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "servers" || name === "timeout") continue
    if (!isRecord(entry)) throw new Error("Invalid legacy MCP server")
    if (typeof entry.enabled === "boolean") states.set(name, !entry.enabled)
    else if (typeof entry.disabled === "boolean") states.set(name, entry.disabled)
    if (!entry.type) continue
    const { enabled, timeout, oauth, ...server } = entry
    const normalizedOAuth = isRecord(oauth) ? Object.fromEntries(Object.entries(oauth).map(([key, value]) => [
      ({ clientId: "client_id", clientSecret: "client_secret", callbackPort: "callback_port", redirectUri: "redirect_uri" })[key] ?? key, value,
    ])) : oauth
    servers[name] = { ...server,
      ...(typeof enabled === "boolean" ? { disabled: !enabled } : {}),
      ...(timeout !== undefined ? { timeout: typeof timeout === "number" ? { catalog: timeout, execution: timeout } : timeout } : {}),
      ...(normalizedOAuth !== undefined ? { oauth: normalizedOAuth } : {}) }
  }
  if (isRecord(raw.servers)) {
    Object.assign(servers, raw.servers)
    // Native entries win even when they omit disabled; do not retain a conflicting V1 enabled flag.
    for (const name of Object.keys(raw.servers)) states.delete(name)
  }
  else if (raw.servers !== undefined) throw new Error("Invalid mcp.servers: expected an object")
  for (const [name, entry] of Object.entries(servers)) {
    if (isRecord(entry) && typeof entry.disabled === "boolean") states.set(name, entry.disabled)
  }
  const config = { ...(raw.timeout !== undefined ? { timeout: raw.timeout } : {}),
    ...(Object.keys(servers).length || isRecord(raw.servers) ? { servers } : {}) }
  // An enabled-only legacy declaration protects that server's activation, not the entire MCP map.
  return { config: Object.keys(config).length || !Object.keys(raw).length ? config : undefined, activation: [...states] }
}

/** Read ordered binary policies, including supported V1 provider filters. */
function policies(raw: RecordValue): Rule[] {
  const rules: Rule[] = []
  if (Array.isArray(raw.enabled_providers)) {
    rules.push({ action: "provider.use", resource: "*", effect: "deny" })
    for (const id of raw.enabled_providers) if (typeof id === "string") rules.push({ action: "provider.use", resource: providerID(id), effect: "allow" })
  }
  if (Array.isArray(raw.disabled_providers)) for (const id of raw.disabled_providers) {
    if (typeof id === "string") rules.push({ action: "provider.use", resource: providerID(id), effect: "deny" })
  }
  const authored = [isRecord(raw.experimental) ? raw.experimental.policies : undefined, raw.policies]
  for (const list of authored) if (Array.isArray(list)) for (const rule of list) {
    if (isRecord(rule) && ["provider.use", "integration.use", "tool.use"].includes(String(rule.action)) &&
      typeof rule.resource === "string" && (rule.effect === "allow" || rule.effect === "deny")) rules.push(rule as Rule)
  }
  return rules
}

/** Normalize aliases before merging, allowing partial fragments without dropping unsupported roots. */
export function normalizeSupportedInput(raw: unknown, source: string, fragment = false): Document<RecordValue> {
  if (!isRecord(raw)) throw new Error(`Invalid config document ${source}: root must be an object`)
  if (fragment) {
    const supported = new Set(["$schema", "agent", "agents", "provider", "providers", "mcp"])
    const unsupported = Object.keys(raw).filter((key) => !supported.has(key))
    if (unsupported.length) throw new Error(`Unsupported config.d root field(s) in ${source}: ${unsupported.join(", ")}`)
    if (isRecord(raw.mcp)) {
      if ("timeout" in raw.mcp) throw new Error(`Unsupported config.d field in ${source}: mcp.timeout`)
      for (const [name, entry] of Object.entries(raw.mcp)) if (name !== "servers" && (!isRecord(entry) || !entry.type)) {
        throw new Error(`Unsupported config.d MCP entry in ${source}: mcp.${name} requires type`)
      }
    }
  }
  let agents: unknown = raw.agent === undefined ? undefined : mapEntries(raw.agent, legacyAgent)
  if (isRecord(raw.mode)) agents = mergeConfigValues(agents ?? {}, mapEntries(raw.mode, (value) => ({ ...legacyAgent(value), mode: "primary" })))
  if (raw.agents !== undefined) agents = mergeConfigValues(agents ?? {}, raw.agents)
  let providers: unknown = raw.provider === undefined ? undefined : Object.fromEntries(
    Object.entries(mapEntries(raw.provider, legacyProvider)).map(([id, value]) => [providerID(id), value]),
  )
  if (raw.providers !== undefined) providers = mergeConfigValues(providers ?? {}, raw.providers)
  const mcp = normalizeMCP(raw.mcp)
  const permissions = raw.permissions ?? legacyPermissions(raw.permission, raw.tools)
  const candidate = { ...(agents !== undefined ? { agents } : {}), ...(providers !== undefined ? { providers } : {}),
    ...(mcp.config ? { mcp: mcp.config } : {}), ...(Array.isArray(permissions) && permissions.length ? { permissions } : {}) }
  return { config: candidate, policies: policies(raw), mcpActivation: mcp.activation }
}

/** Decode complete documents; fragment callers instead validate their fully merged normalized inputs. */
export function normalizeSupportedDocument(raw: unknown, source: string, fragment = false): Document {
  const document = normalizeSupportedInput(raw, source, fragment)
  return { ...document, config: decodeConfig(document.config, source, fragment) }
}

/** Map named configuration entries while rejecting malformed maps before schema decoding. */
function mapEntries(value: unknown, convert: (value: unknown) => RecordValue): RecordValue {
  if (!isRecord(value)) throw new Error("Invalid configuration map")
  return Object.fromEntries(Object.entries(value).map(([id, item]) => [id, convert(item)]))
}
