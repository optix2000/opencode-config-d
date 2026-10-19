import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Agent, Model, Plugin, Provider, type Mcp } from "@opencode/plugin"
import { Schema } from "effect"
import ConfigDPlugin, { discoverProjectConfig, loadFragments, normalizeSupportedDocument, parseAgentMarkdown, parseConfigDocument } from "../src/index"
import { projectDenies } from "../src/discovery"

const temporary: string[] = []
const environment = { ...process.env }
beforeEach(() => {
  // The coding harness injects its own inline config. Test fixtures must not inherit it.
  delete process.env.OPENCODE_CONFIG_CONTENT
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
  Object.assign(process.env, environment)
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Isolated sources never touch the live OpenCode configuration or any repository. */
async function fixture() {
  const parent = path.join(os.tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "config-d-"))
  temporary.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  await Promise.all([mkdir(path.join(global, "config.d"), { recursive: true }), mkdir(project)])
  /** Write a config fixture, creating only its isolated parent directories. */
  const put = async (file: string, content: unknown) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
  }
  return { root, global, project, put,
    fragment: (name: string, content: unknown) => put(path.join(global, "config.d", name), content),
    config: (content: unknown, name = "opencode.jsonc") => put(path.join(project, name), content),
    snapshot: () => discoverProjectConfig({ directory: project, globalDirectory: global, environment: {} }) }
}

type Editor<D extends "agent" | "provider" | "model" | "mcp"> = Parameters<Parameters<Plugin.Context[D]["transform"]>[0]>[0]
type Callback<D extends "agent" | "provider" | "model" | "mcp"> = (editor: Editor<D>) => void
type Mutable<T> = T extends string | number | boolean ? T : T extends (...args: never[]) => unknown ? T : T extends readonly (infer I)[] ? Mutable<I>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T

/** Minimal native host: replay every transform onto fresh source state, including disposal and model materialization. */
function host(directory: string, globalDirectory: string, initial: {
  agents?: Agent.Info[]
  providers?: Array<{ info: Provider.Info; models: Model.Info[] }>
  mcp?: Record<string, Mcp.ServerConfig>
} = {}) {
  const callbacks = { agent: new Set<Callback<"agent">>(), provider: new Set<Callback<"provider">>(),
    model: new Set<Callback<"model">>(), mcp: new Set<Callback<"mcp">>() }
  /** Replays against fresh public schema values; transform reads see the changes registered so far. */
  function state() {
    const agents = new Map((initial.agents ?? [Agent.Info.default(Agent.ID.make("build")), Agent.Info.default(Agent.ID.make("explore"))])
      .map((agent) => [String(agent.id), structuredClone(agent) as Mutable<Agent.Info>]))
    const providers = new Map((initial.providers ?? []).map(({ info, models }) => [String(info.id), {
      provider: structuredClone(info) as Mutable<Provider.Info>, models: new Map(models.map((model) => [String(model.id), structuredClone(model)])),
    }]))
    const mcp = new Map(Object.entries(structuredClone(initial.mcp ?? {}) as Mutable<Record<string, Mcp.ServerConfig>>))
    const agentEditor: Editor<"agent"> = { list: () => [...agents.values()], get: (id) => agents.get(id),
      update: (id, update) => { const item = agents.get(id); if (item) update(item) }, remove: (id) => { agents.delete(id) }, default: () => {} }
    const providerEditor: Editor<"provider"> = { list: () => [...providers.values()], get: (id) => providers.get(id),
      add: ({ info, models }) => {
        Schema.decodeUnknownSync(Provider.Info)(info)
        models.forEach((model) => Schema.decodeUnknownSync(Model.Info)(model))
        providers.set(String(info.id), { provider: structuredClone(info), models: new Map(models.map((model) => [String(model.id), structuredClone(model)])) })
      }, update: (id, update) => { const item = providers.get(id); if (item) update(item.provider) },
      remove: (id) => { providers.delete(id) }, models: {
        set: (id, models) => { const item = providers.get(id); if (item) item.models = new Map(models.map((model) => [String(model.id), structuredClone(model)])) },
        update: () => {}, remove: () => {},
      } }
    const mcpEditor: Editor<"mcp"> = { list: () => [...mcp], get: (id) => mcp.get(id),
      set: (id, server) => { mcp.set(id, structuredClone(server) as Mutable<Mcp.ServerConfig>) }, remove: (id) => { mcp.delete(id) },
      update: (id, update) => { const item = mcp.get(id); if (item) update(item) } }
    callbacks.agent.forEach((callback) => callback(agentEditor))
    callbacks.provider.forEach((callback) => callback(providerEditor))
    const models = new Map([...providers].filter(([, record]) => record.provider.activation !== "disabled")
      .flatMap(([id, record]) => [...record.models].map(([modelID, model]) => [`${id}/${modelID}`, structuredClone(model) as Mutable<Model.Info>] as const)))
    const modelEditor: Editor<"model"> = { list: (id) => [...models.values()].filter((model) => !id || model.providerID === id),
      get: (id, model) => models.get(`${id}/${model}`), update: (id, model, update) => {
        const item = models.get(`${id}/${model}`); if (item) update(item)
      }, remove: (id, model) => { models.delete(`${id}/${model}`) },
      provider: { list: () => [...providers.values()], get: (id) => providers.get(id) },
      default: { get: () => undefined, set: () => {} } }
    callbacks.model.forEach((callback) => callback(modelEditor))
    callbacks.mcp.forEach((callback) => callback(mcpEditor))
    return { agents, providers, models, mcp }
  }
  /** Registrations are validated immediately and removed if replay fails. */
  function domain<D extends keyof typeof callbacks>(name: D) {
    return { transform: async (callback: Callback<D>) => {
      const set = callbacks[name] as Set<Callback<D>>
      set.add(callback)
      try { state() } catch (error) { set.delete(callback); throw error }
      return { dispose: async () => { set.delete(callback) } }
    } }
  }
  const context = { location: { directory }, options: { globalDirectory },
    agent: { ...domain("agent"), list: async () => ({ data: [...state().agents.values()], location: { directory } }) },
    provider: domain("provider"), model: domain("model"), mcp: domain("mcp") } as unknown as Plugin.Context
  return { context, state, registrations: () => Object.values(callbacks).reduce((sum, set) => sum + set.size, 0) }
}

/** Native public defaults for a source provider and model. */
function provider(id = "openai", model = "test"): { info: Mutable<Provider.Info>; models: Model.Info[] } {
  return { info: { ...Provider.Info.empty(Provider.ID.make(id)), activation: "enabled" as const },
    models: [Model.Info.default(Provider.ID.make(id), Model.ID.make(model))] }
}

test("stable native entrypoint and no fragments require no global base file", async () => {
  const f = await fixture()
  const h = host(f.project, f.global)
  expect(ConfigDPlugin.id).toBe("opencode-config-d")
  expect(await ConfigDPlugin.setup(h.context)).toBeUndefined()
  expect(h.registrations()).toBe(0)
})

test("merges lexical JSON/JSONC fragments and replaces arrays through native agent transforms", async () => {
  const f = await fixture()
  await f.fragment("20-overlay.json", { agents: { build: { request: { body: { nested: { b: 2 }, array: [2] } } } } })
  await f.fragment("10-base.jsonc", '// comment\n{"agents":{"build":{"request":{"body":{"nested":{"a":1},"array":[1]}}}},}')
  await f.fragment("30-last.JSON", { agents: { build: { description: "last" } } })
  await f.put(path.join(f.global, "config.d", "ignored.txt"), "invalid")
  await mkdir(path.join(f.global, "config.d", "directory.jsonc"))
  const h = host(f.project, f.global)
  const cleanup = await ConfigDPlugin.setup(h.context)
  const agent = h.state().agents.get("build")!
  expect(agent.request.body).toEqual({ nested: { a: 1, b: 2 }, array: [2] })
  expect(agent.description).toBe("last")
  expect(h.state().agents.get("build")).toEqual(agent)
  expect(h.registrations()).toBe(4)
  await cleanup?.()
  expect(h.registrations()).toBe(0)
})

test("expands legacy provider env/file placeholders without exposing secrets", async () => {
  const f = await fixture()
  process.env.CONFIG_D_TEST_VALUE = 'quote" backslash\\ newline\n {file:never-read}'
  await f.put(path.join(f.global, "config.d", "secret.txt"), "from-file\n")
  await f.fragment("10-provider.jsonc", { provider: { test: { npm: "@ai-sdk/openai-compatible", options: {
    apiKey: "{env:CONFIG_D_TEST_VALUE}", token: "{file:secret.txt}",
  } } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  expect(h.state().providers.get("test")?.provider.settings).toEqual({ apiKey: process.env.CONFIG_D_TEST_VALUE, token: "from-file" })
  expect(h.state().providers.get("test")?.provider.package).toBe("aisdk:@ai-sdk/openai-compatible")
})

test("substitutions preserve strings, comments and missing envs without recursive expansion", async () => {
  const f = await fixture()
  const secret = '"},"injected":true,"x":"\\\n'
  const parsed = await parseConfigDocument('// {file:missing}\n{"key":"prefix {env:KEY} suffix","empty":"{env:MISSING}"}', "fixture", f.root, { KEY: secret })
  expect(parsed).toEqual({ key: `prefix ${secret} suffix`, empty: "" })
  await expect(parseConfigDocument('{"key":"{file:missing}"}', "fixture", f.root)).rejects.toThrow("referenced file is not readable")
})

test("parse/schema errors never include credential values", async () => {
  const f = await fixture()
  const secret = "DO-NOT-LOG-THIS"
  try { normalizeSupportedDocument({ agents: { build: { steps: secret } } }, "secret.json", true) }
  catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).toContain("secret.json") }
  await expect(parseConfigDocument(`{"secret":"${secret}", broken}`, "bad.json", f.root)).rejects.toThrow("Invalid JSONC in bad.json at offset")
})

test.each(["permission", "permissions", "policies", "plugins", "commands", "model", "instructions", "unknown"])("rejects unsupported fragment root %s", async (field) => {
  const f = await fixture()
  await f.fragment("10-invalid.json", { [field]: {} })
  await expect(ConfigDPlugin.setup(host(f.project, f.global).context)).rejects.toThrow("Unsupported config.d root field")
})

test("rejects unsupported MCP defaults and invalid native nested fields", () => {
  expect(() => normalizeSupportedDocument({ mcp: { timeout: { catalog: 5 } } }, "fragment", true)).toThrow("mcp.timeout")
  expect(() => normalizeSupportedDocument({ agents: { build: { typo: true } } }, "fragment", true)).toThrow("Invalid supported config schema")
  expect(() => normalizeSupportedDocument({ mcp: { disabled: { enabled: false } } }, "fragment", true)).toThrow("requires type")
})

test("unknown agents fail clearly and partial setup registrations are disposed", async () => {
  const f = await fixture()
  await f.fragment("10-agent.json", { agents: { new_agent: { system: "new" } } })
  const h = host(f.project, f.global)
  await expect(ConfigDPlugin.setup(h.context)).rejects.toThrow("creating new agents")
  expect(h.registrations()).toBe(0)
})

test("native shorthand model selection and ordered fragment permissions match dotfiles integration", async () => {
  const f = await fixture()
  await f.fragment("explore.jsonc", { agents: { explore: { model: "openai/gpt-6.1-sol#high-encrypted", permissions: [{ action: "ast", resource: "*", effect: "allow" }] } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  expect(h.state().agents.get("explore")?.model).toEqual(Model.Ref.parse("openai/gpt-6.1-sol#high-encrypted"))
  expect(h.state().agents.get("explore")?.permissions.at(-1)).toEqual({ action: "ast", resource: "*", effect: "allow" })
})

test("explicit same-as-fragment project leaves beat global fragments and provider variants stay native", async () => {
  const f = await fixture()
  const source = provider()
  source.info.name = "project-name"
  source.models[0] = { ...source.models[0]!, name: "project-model", variants: [{ id: Model.VariantID.make("high-encrypted"), settings: { reasoningEffort: "high" }, body: { include: ["reasoning.encrypted_content"] } }] }
  await f.config({ agents: { explore: { model: "openai/test#high-encrypted", description: "same" } }, providers: { openai: { name: "project-name", models: { test: { name: "project-model", variants: source.models[0].variants } } } } })
  await f.fragment("10-fragment.json", { agents: { explore: { model: "other/other", description: "same", system: "default" } }, providers: { openai: { name: "fragment", models: { test: { name: "fragment", variants: [] } } } } })
  const agent = { ...Agent.Info.default(Agent.ID.make("explore")), model: Model.Ref.parse("openai/test#high-encrypted"), description: "same" }
  const h = host(f.project, f.global, { agents: [agent], providers: [source] })
  await ConfigDPlugin.setup(h.context)
  expect(h.state().agents.get("explore")?.model).toEqual(agent.model)
  expect(h.state().agents.get("explore")?.system).toBe("default")
  expect(h.state().models.get("openai/test")?.variants).toMatchObject(source.models[0].variants)
  expect(h.state().providers.get("openai")?.provider.name).toBe("project-name")
  expect((await f.snapshot()).explicit.has("agents.explore.description")).toBe(true)
})

test("all project permission arrays retain order after broad fragment allows, including ancestor denies", async () => {
  const f = await fixture()
  await f.put(path.join(f.root, "opencode.jsonc"), { permissions: [{ action: "edit", resource: "private/*", effect: "deny" }] })
  await f.config({ permissions: [{ action: "shell", resource: "git push *", effect: "deny" }], agents: { build: { permissions: [{ action: "ast", resource: "*", effect: "deny" }] } } })
  await f.fragment("10-permissions.json", { agents: { build: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  expect(h.state().agents.get("build")?.permissions.slice(-4)).toEqual([
    { action: "*", resource: "*", effect: "allow" }, { action: "edit", resource: "private/*", effect: "deny" },
    { action: "shell", resource: "git push *", effect: "deny" }, { action: "ast", resource: "*", effect: "deny" },
  ])
})

test("native agent Markdown protects model, disabled, request and permission declarations", async () => {
  const f = await fixture()
  await f.config(`---\nmodel: openai/test#high\ndisabled: false\nrequest:\n  body:\n    temperature: 0.2\npermissions:\n  - action: edit\n    resource: '*'\n    effect: deny\n---\nNative system\n`, ".opencode/agents/explore.md")
  const snapshot = await f.snapshot()
  expect(snapshot.config.agents?.explore).toMatchObject({ model: { providerID: "openai", model: "test", variant: "high" }, disabled: false, system: "Native system", request: { body: { temperature: 0.2 } } })
  expect(snapshot.agentPermissions.get("explore")).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
  expect(snapshot.config.agents?.explore?.request?.body).not.toHaveProperty("permissions")
})

test("legacy agent Markdown, modes and nested path-derived IDs remain supported", async () => {
  const f = await fixture()
  await f.config(`---\nmodel: openai/test\nvariant: high\ndisable: false\npermission:\n  bash: deny\ntemperature: 0.3\n---\nLegacy\n`, ".opencode/agents/nested/reviewer.md")
  await f.config("---\ndescription: mode\n---\nPrimary", ".opencode/modes/review.md")
  const snapshot = await f.snapshot()
  expect(snapshot.config.agents?.["nested/reviewer"]).toMatchObject({ model: { variant: "high" }, disabled: false, system: "Legacy", request: { body: { temperature: 0.3 } }, permissions: [{ action: "shell", resource: "*", effect: "deny" }] })
  expect(snapshot.config.agents?.review?.mode).toBe("primary")
  expect(() => parseAgentMarkdown("---\n[a\n---\nbody", "x", "broken.md")).toThrow("Invalid agent frontmatter")
})

test("native Markdown BOM, CRLF and unquoted colon scalars retain their declarations", () => {
  const raw = parseAgentMarkdown('\uFEFF---\r\nmodel: openai/test#high\r\ndescription: Review: carefully\r\n--- \r\nNative body', "review", "review.md")
  const config = normalizeSupportedDocument(raw, "review.md").config
  expect(config.agents?.review).toMatchObject({ description: "Review: carefully", model: { variant: "high" }, system: "Native body" })
})

test("direct, .opencode, explicit and inline sources are discovered in native setting precedence", async () => {
  const f = await fixture()
  await f.put(path.join(f.root, "explicit.json"), { agents: { build: { description: "explicit" } } })
  await f.config({ agents: { build: { description: "direct" } } })
  await f.config({ agents: { build: { description: "dot" } } }, ".opencode/opencode.jsonc")
  const base = { directory: f.project, globalDirectory: f.global }
  expect((await discoverProjectConfig({ ...base, environment: { OPENCODE_CONFIG: "../explicit.json" } })).config.agents?.build?.description).toBe("dot")
  expect((await discoverProjectConfig({ ...base, environment: { OPENCODE_CONFIG_CONTENT: '{"agents":{"build":{"description":"inline"}}}' } })).config.agents?.build?.description).toBe("inline")
  expect((await discoverProjectConfig({ ...base, environment: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" } })).sources).toEqual([])
})

test("ordered top-level policies support wildcards and broader source authority", async () => {
  const f = await fixture()
  await f.put(path.join(f.root, "opencode.jsonc"), { policies: [{ action: "provider.use", resource: "company-*", effect: "deny" }, { action: "provider.use", resource: "company-safe", effect: "allow" }] })
  await f.config({ policies: [{ action: "provider.use", resource: "company-*", effect: "allow" }] })
  const snapshot = await f.snapshot()
  expect(projectDenies(snapshot, "provider.use", "company-unsafe")).toBe(true)
  expect(projectDenies(snapshot, "provider.use", "company-safe")).toBe(false)
  expect(projectDenies(snapshot, "provider.use", "other")).toBe(false)
})

test("legacy provider filters and experimental policies keep their ordered restrictions", async () => {
  const f = await fixture()
  await f.config({ enabled_providers: ["openai"], disabled_providers: ["blocked"], experimental: { policies: [{ action: "provider.use", resource: "openai", effect: "deny" }] } })
  const snapshot = await f.snapshot()
  expect(projectDenies(snapshot, "provider.use", "openai")).toBe(true)
  expect(projectDenies(snapshot, "provider.use", "new")).toBe(true)
})

test("does not resurrect project-disabled providers, models, agents or MCP servers", async () => {
  const f = await fixture()
  await f.config({ policies: [{ action: "provider.use", resource: "blocked", effect: "deny" }], agents: { explore: { disabled: true } },
    providers: { openai: { models: { test: { disabled: true } } } }, mcp: { servers: { stopped: { type: "remote", url: "https://example.com", disabled: true } } } })
  await f.fragment("10-activation.json", { agents: { explore: { disabled: false } }, providers: {
    blocked: { package: "@opencode/ai/providers/openai-compatible", models: { test: {} } }, openai: { models: { test: { disabled: false } } },
  }, mcp: { servers: { stopped: { type: "remote", url: "https://example.com", disabled: false } } } })
  const h = host(f.project, f.global, { agents: [], providers: [provider()] })
  await ConfigDPlugin.setup(h.context)
  expect(h.state().providers.has("blocked")).toBe(false)
  expect(h.state().agents.has("explore")).toBe(false)
  expect(h.state().mcp.has("stopped")).toBe(false)
  expect(h.state().models.get("openai/test")?.enabled).toBe(true) // Mock native baseline is deliberately untouched by this plugin.
})

test("does not re-enable disabled host sources, models or MCP servers without project files", async () => {
  const f = await fixture()
  const inactive = provider("inactive")
  const disabledProvider = { info: { ...inactive.info, activation: "disabled" as const }, models: inactive.models }
  const source = provider()
  source.models[0] = { ...source.models[0]!, enabled: false }
  await f.fragment("10-activation.json", { providers: { inactive: { name: "changed" }, openai: { models: { test: { disabled: false } } } },
    mcp: { servers: { stopped: { type: "remote", url: "https://changed.example", disabled: false } } } })
  const h = host(f.project, f.global, { providers: [disabledProvider, source], mcp: { stopped: { type: "remote", url: "https://example.com", disabled: true } } })
  await ConfigDPlugin.setup(h.context)
  expect(h.state().providers.get("inactive")?.provider.name).toBe("inactive")
  expect(h.state().models.get("openai/test")?.enabled).toBe(false)
  expect(h.state().mcp.get("stopped")?.disabled).toBe(true)
})

test("new provider models use schema-native cost, variants, capabilities and disabled semantics", async () => {
  const f = await fixture()
  await f.fragment("10-model.json", { providers: { custom: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://example.com" }, models: {
    test: { modelID: "upstream", disabled: false, cost: { input: 1, output: 2 }, capabilities: { input: ["text"], tools: false }, variants: [{ id: "high", settings: { reasoningEffort: "high" }, body: { include: ["encrypted"] } }] },
    off: { disabled: true },
  } } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  const model = h.state().models.get("custom/test")!
  expect(String(model.modelID)).toBe("upstream")
  expect(model.cost).toMatchObject([{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
  expect(model.capabilities).toMatchObject({ tools: false, input: ["text"], output: ["text"] })
  expect(model.enabled).toBe(true)
  expect(h.state().models.get("custom/off")?.enabled).toBe(false)
  Schema.decodeUnknownSync(Model.Info)(model)
})

test("native project release dates protect the lowered runtime time field", async () => {
  const f = await fixture()
  await f.config({ providers: { openai: { models: { test: { releaseDate: "2026-01-01" } } } } })
  await f.fragment("10-date.json", { providers: { openai: { models: { test: { releaseDate: "2025-01-01" } } } } })
  const source = provider()
  source.models[0] = { ...source.models[0]!, time: { released: Date.parse("2026-01-01") } }
  const h = host(f.project, f.global, { providers: [source] })
  await ConfigDPlugin.setup(h.context)
  expect(h.state().models.get("openai/test")?.time.released).toBe(Date.parse("2026-01-01"))
})

test("failed later domain registration disposes previously registered transforms", async () => {
  const f = await fixture()
  await f.fragment("10-agent.json", { agents: { build: { description: "temporary" } } })
  const h = host(f.project, f.global)
  const context = { ...h.context, mcp: { ...h.context.mcp, transform: async () => { throw new Error("registration failed") } } }
  await expect(ConfigDPlugin.setup(context)).rejects.toThrow("registration failed")
  expect(h.registrations()).toBe(0)
  expect(h.state().agents.get("build")?.description).toBeUndefined()
})

test("native project disabled:false beats a fragment model disabled:true for new providers", async () => {
  const f = await fixture()
  await f.config({ providers: { custom: { models: { test: { disabled: false } } } } })
  await f.fragment("10-model.json", { providers: { custom: { models: { test: { disabled: true } } } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  expect(h.state().models.get("custom/test")?.enabled).toBe(true)
})

test("legacy local models migrate options, variants, costs and modalities", async () => {
  const f = await fixture()
  await f.fragment("10-local.json", { provider: { local: { npm: "@ai-sdk/openai-compatible", api: "http://localhost:8000/v1", models: {
    test: { id: "upstream", options: { reasoningEffort: "high", custom_flag: true }, variants: { high: { reasoningEffort: "high", include: ["encrypted"] } }, cost: { input: 0, output: 0, cache_read: 0 }, tool_call: true, modalities: { input: ["text"], output: ["text"] } },
  } } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  const model = h.state().models.get("local/test")!
  expect(model.settings).toMatchObject({ reasoningEffort: "high" })
  expect(model.body).toEqual({ custom_flag: true })
  expect(model.variants).toMatchObject([{ id: "high", settings: { reasoningEffort: "high" }, body: { include: ["encrypted"] } }])
})

test("native MCP declaration wins over legacy same-name entry and project type is never mixed", async () => {
  const f = await fixture()
  const normalized = normalizeSupportedDocument({ mcp: { docs: { type: "local", command: ["old"], enabled: false }, servers: { docs: { type: "remote", url: "https://native.example", disabled: false } } } }, "mixed")
  expect(normalized.config.mcp?.servers?.docs).toMatchObject({ type: "remote", disabled: false })
  await f.config({ mcp: { servers: { docs: { type: "remote", url: "https://project.example" } } } })
  await f.fragment("10-mcp.json", { mcp: { docs: { type: "local", command: ["fragment"], enabled: true } } })
  const h = host(f.project, f.global, { mcp: { docs: { type: "remote", url: "https://project.example" } } })
  await ConfigDPlugin.setup(h.context)
  expect(h.state().mcp.get("docs")).toEqual({ type: "remote", url: "https://project.example" })
})

test("an enabled-only legacy MCP deny protects just that server, not unrelated additions", async () => {
  const f = await fixture()
  await f.config({ mcp: { stopped: { enabled: false } } })
  await f.fragment("10-mcp.json", { mcp: { servers: {
    stopped: { type: "remote", url: "https://stopped.example", disabled: false },
    fresh: { type: "remote", url: "https://fresh.example" },
  } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  expect(h.state().mcp.has("stopped")).toBe(false)
  expect(h.state().mcp.has("fresh")).toBe(true)
})

test("explicit empty provider and MCP maps are not repopulated by fragment defaults", async () => {
  const f = await fixture()
  await f.config({ providers: {}, mcp: { servers: {} } })
  await f.fragment("10-empty.json", { providers: { custom: { models: { test: {} } } },
    mcp: { servers: { docs: { type: "remote", url: "https://example.com" } } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  expect(h.state().providers.size).toBe(0)
  expect(h.state().mcp.size).toBe(0)
})

test("empty project maps protect subtrees and MCP integration policies prohibit additions", async () => {
  const f = await fixture()
  await f.config({ agents: { build: { request: { body: {} } } }, policies: [{ action: "integration.use", resource: "mcp:*", effect: "deny" }] })
  await f.fragment("10-empty.json", { agents: { build: { request: { body: { injected: true } } } }, mcp: { servers: { docs: { type: "remote", url: "https://example.com" } } } })
  const h = host(f.project, f.global)
  await ConfigDPlugin.setup(h.context)
  expect(h.state().agents.get("build")?.request.body).toEqual({})
  expect(h.state().mcp.size).toBe(0)
})

test("unsupported reasoning lowering fails rather than silently dropping native model capabilities", async () => {
  const f = await fixture()
  await f.fragment("10-reasoning.json", { providers: { custom: { models: { test: { capabilities: { reasoning: { supported: true, effort: ["high"] } } } } } } })
  const h = host(f.project, f.global)
  await expect(ConfigDPlugin.setup(h.context)).rejects.toThrow("capabilities.reasoning")
  expect(h.registrations()).toBe(0)
})

test("source tree imports no V1 plugin or machine-specific migration source", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  expect(source).not.toContain("@opencode-ai/")
  expect(source).not.toContain("/Users/")
})
