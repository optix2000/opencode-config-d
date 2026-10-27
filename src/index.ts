/** Native V2 config.d defaults, using only released domain transforms (no mutable config hook). */
import { homedir } from "node:os"
import path from "node:path"
import { Plugin, Model, Provider } from "@opencode/plugin"
import type { Config } from "@opencode/schema/config"
import { declared, discoverProjectConfig, expandRules, loadFragments, projectDenies, protectedSubtree, type ProjectSnapshot } from "./discovery"
import { isRecord, mergeConfigValues, type RecordValue } from "./normalize"

export { discoverProjectConfig, loadFragments, parseConfigDocument, parseAgentMarkdown } from "./discovery"
export { mergeConfigValues, normalizeSupportedDocument } from "./normalize"

/** Mutable domain drafts retain their public schema shape without introducing any-typed hooks. */
type Mutable<T> = T extends string | number | boolean ? T : T extends (...args: never[]) => unknown ? T : T extends readonly (infer I)[] ? Mutable<I>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T
type ProviderConfig = NonNullable<Config.Info["providers"]>[string]
type ModelConfig = NonNullable<ProviderConfig["models"]>[string]
type AgentEditor = Parameters<Parameters<Plugin.Context["agent"]["transform"]>[0]>[0]
type AgentDraft = NonNullable<ReturnType<AgentEditor["get"]>>

/** Overlay only fragment leaves not explicitly declared by a project source. */
function applyOverlay(target: RecordValue, fragment: RecordValue, project: ProjectSnapshot, prefix: string): void {
  for (const [key, value] of Object.entries(fragment)) {
    const field = `${prefix}.${key}`
    if (!isRecord(value)) { if (!declared(project, field)) target[key] = structuredClone(value); continue }
    if (project.explicit.has(field)) continue
    if (!isRecord(target[key])) target[key] = {}
    applyOverlay(target[key] as RecordValue, value, project, field)
  }
}

/** Assign a higher-precedence normalized source without retaining class prototypes. */
function assignOverlay(target: RecordValue, input: RecordValue): void {
  Object.assign(target, mergeConfigValues(target, input))
}

/** Convert config-only model fields to their public runtime schema representation. */
function modelInput(config: ModelConfig): RecordValue {
  const { disabled, cost, releaseDate, capabilities, ...input } = config
  const result: RecordValue = { ...input }
  if (cost !== undefined) result.cost = (Array.isArray(cost) ? cost : [cost]).map((tier) => ({
    ...tier, cache: { read: tier.cache?.read ?? 0, write: tier.cache?.write ?? 0 },
  }))
  if (releaseDate !== undefined) result.time = { released: Date.parse(releaseDate) || 0 }
  if (capabilities) {
    const { reasoning, ...runtime } = capabilities
    if (reasoning !== undefined) throw new Error("config.d capabilities.reasoning cannot be lowered through the public model editor; configure it in native providers instead")
    result.capabilities = runtime
  }
  return result
}

/** Build native source models using the released defaults, with explicit project model overrides last. */
export function buildModel(providerID: string, modelID: string, fragment: ModelConfig, project: ProjectSnapshot): Model.Info {
  const model: Mutable<Model.Info> = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(modelID))
  assignOverlay(model as unknown as RecordValue, modelInput(fragment))
  const projectModel = project.config.providers?.[providerID]?.models?.[modelID]
  if (projectModel) assignOverlay(model as unknown as RecordValue, modelInput(projectModel))
  model.enabled = !(projectModel?.disabled ?? fragment.disabled ?? false)
  return model
}

/** Build fragment-only providers; environment-name activation is not exposed by Provider.Info. */
export function buildProvider(providerID: string, fragment: ProviderConfig, project: ProjectSnapshot): { info: Provider.Info; models: Model.Info[] } {
  const info = { ...Provider.Info.empty(Provider.ID.make(providerID)), activation: "enabled" as const }
  const { models, env, ...input } = fragment
  assignOverlay(info as unknown as RecordValue, input)
  const projectProvider = project.config.providers?.[providerID]
  if (projectProvider) {
    const { models, env, ...input } = projectProvider
    assignOverlay(info as unknown as RecordValue, input)
  }
  const ids = new Set([...Object.keys(models ?? {}), ...Object.keys(projectProvider?.models ?? {})])
  return { info, models: [...ids].map((id) => buildModel(providerID, id, models?.[id] ?? {}, project)) }
}

/** Apply agent defaults while replaying all ordered project permission rules after fragment rules. */
export function applyAgentDefaults(agent: AgentDraft, fragment: NonNullable<Config.Info["agents"]>[string], project: ProjectSnapshot): void {
  const prefix = `agents.${agent.id}`
  if (protectedSubtree(project, prefix)) return
  if (fragment.model && !declared(project, `${prefix}.model`)) {
    const { providerID, model, variant } = fragment.model
    if (!projectDenies(project, "provider.use", providerID) && !project.config.providers?.[providerID]?.models?.[model]?.disabled) {
      agent.model = Model.Ref.parse(`${providerID}/${model}${variant ? `#${variant}` : ""}`)
    }
  }
  if (fragment.request) applyOverlay(agent.request as unknown as RecordValue, fragment.request as unknown as RecordValue, project, `${prefix}.request`)
  const scalars: RecordValue = {}
  for (const key of ["system", "description", "mode", "hidden", "color", "steps"] as const) if (fragment[key] !== undefined) scalars[key] = fragment[key]
  applyOverlay(agent as unknown as RecordValue, scalars, project, prefix)
  if (fragment.permissions?.length) {
    agent.permissions = [...agent.permissions, ...expandRules(fragment.permissions), ...project.permissions, ...(project.agentPermissions.get(String(agent.id)) ?? [])]
  }
}

/** Contribute provider sources without reviving disabled providers or source models. */
function transformProviders(editor: Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0], fragments: Config.Info, project: ProjectSnapshot): void {
  for (const [id, fragment] of Object.entries(fragments.providers ?? {})) {
    if (projectDenies(project, "provider.use", id) || protectedSubtree(project, `providers.${id}`)) continue
    const record = editor.get(id)
    if (!record) { editor.add(buildProvider(id, fragment, project)); continue }
    if (record.provider.activation === "disabled") continue
    editor.update(id, (provider) => {
      const { models, env, ...input } = fragment
      applyOverlay(provider as unknown as RecordValue, input, project, `providers.${id}`)
    })
    const additions: Model.Info[] = []
    for (const [modelID, model] of Object.entries(fragment.models ?? {})) {
      if (protectedSubtree(project, `providers.${id}.models.${modelID}`)) continue
      if (project.config.providers?.[id]?.models?.[modelID]?.disabled || record.models.get(modelID)?.enabled === false) continue
      if (!record.models.has(modelID)) additions.push(buildModel(id, modelID, model, project))
    }
    if (additions.length) editor.models.set(id, [...record.models.values(), ...additions])
  }
}

/** Edit the complete model collection after provider source contributions become visible. */
function transformModels(editor: Parameters<Parameters<Plugin.Context["model"]["transform"]>[0]>[0], fragments: Config.Info, project: ProjectSnapshot): void {
  for (const [providerID, provider] of Object.entries(fragments.providers ?? {})) {
    if (projectDenies(project, "provider.use", providerID)) continue
    for (const [id, fragment] of Object.entries(provider.models ?? {})) {
      if (protectedSubtree(project, `providers.${providerID}.models.${id}`)) continue
      const current = editor.get(providerID, id)
      if (!current || !current.enabled || project.config.providers?.[providerID]?.models?.[id]?.disabled) continue
      editor.update(providerID, id, (model) => {
        applyOverlay(model as unknown as RecordValue, modelInput(fragment), project, `providers.${providerID}.models.${id}`)
        if (fragment.disabled !== undefined && !declared(project, `providers.${providerID}.models.${id}.disabled`)) model.enabled = !fragment.disabled
      })
    }
  }
}

/** Overlay MCP server defaults, preserving project union discriminants and every disabled server. */
function transformMCP(editor: Parameters<Parameters<Plugin.Context["mcp"]["transform"]>[0]>[0], fragments: Config.Info, project: ProjectSnapshot): void {
  for (const [name, fragment] of Object.entries(fragments.mcp?.servers ?? {})) {
    if (project.disabledMCP.has(name) || projectDenies(project, "integration.use", `mcp:${name}`)) continue
    const prefix = `mcp.servers.${name}`
    if (protectedSubtree(project, prefix)) continue
    const current = editor.get(name)
    if (current?.disabled) continue
    if (!current) { if (!declared(project, prefix)) editor.set(name, structuredClone(fragment)); continue }
    if (current.type !== fragment.type) {
      if (!declared(project, `${prefix}.type`)) editor.set(name, structuredClone(fragment))
      continue
    }
    editor.update(name, (server) => applyOverlay(server as unknown as RecordValue, fragment as unknown as RecordValue, project, prefix))
  }
}

/** Register replayable domain edits and clean up successful registrations if a later setup step fails. */
async function registerTransforms(ctx: Plugin.Context, fragments: Config.Info, project: ProjectSnapshot): Promise<() => Promise<void>> {
  // Validate unsupported inputs outside callbacks: some hosts log transform exceptions instead of rejecting setup.
  const agentIDs = Object.keys(fragments.agents ?? {}).filter((id) => !protectedSubtree(project, `agents.${id}`))
  if (agentIDs.length) {
    const loaded = new Set((await ctx.agent.list()).data.map((agent) => agent.id))
    for (const id of agentIDs) if (!loaded.has(id) && !project.config.agents?.[id]?.disabled) {
      throw new Error(`config.d agent "${id}" is not loaded; creating new agents through the V2 public editor is unsupported`)
    }
  }
  for (const provider of Object.values(fragments.providers ?? {})) for (const model of Object.values(provider.models ?? {})) modelInput(model)
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const dispose = async () => { await Promise.all(registrations.map((registration) => registration.dispose())) }
  try {
    registrations.push(await ctx.agent.transform((editor) => {
      for (const [id, fragment] of Object.entries(fragments.agents ?? {})) {
        if (project.config.agents?.[id]?.disabled || protectedSubtree(project, `agents.${id}`)) continue
        const agent = editor.get(id)
        // A later reload may remove an originally loaded agent. Never recreate it.
        if (!agent) continue
        if (fragment.disabled && project.config.agents?.[id]?.disabled !== false) { editor.remove(id); continue }
        editor.update(id, (agent) => applyAgentDefaults(agent, fragment, project))
      }
    }))
    registrations.push(await ctx.provider.transform((editor) => transformProviders(editor, fragments, project)))
    registrations.push(await ctx.model.transform((editor) => transformModels(editor, fragments, project)))
    registrations.push(await ctx.mcp.transform((editor) => transformMCP(editor, fragments, project)))
    return dispose
  } catch (error) { await dispose(); throw error }
}

/** Resolve normal XDG configuration, optionally overridden for an isolated plugin instance. */
function globalDirectory(ctx: Plugin.Context): string {
  if (typeof ctx.options.globalDirectory === "string") return path.resolve(ctx.options.globalDirectory)
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return path.join(xdg ? path.resolve(xdg) : path.join(homedir(), ".config"), "opencode")
}

export const ConfigDPlugin = Plugin.define({
  id: "opencode-config-d",
  async setup(ctx) {
    const global = globalDirectory(ctx)
    const fragments = await loadFragments(global)
    if (!fragments.files.length) return
    const project = await discoverProjectConfig({ directory: String(ctx.location.directory), globalDirectory: global })
    return registerTransforms(ctx, fragments.config, project)
  },
})

export default ConfigDPlugin
