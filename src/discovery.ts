/** File loading and explicit project-source provenance, adapted from the scoped V2 port. */
import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Config } from "@opencode/schema/config"
import { parse as parseJSONC, type ParseError } from "jsonc-parser"
import { parse as parseYAML } from "yaml"
import { agentMarkdownDocument, decodeConfig, isRecord, mergeConfigValues, normalizeSupportedDocument, type Document, type Rule } from "./normalize"

/** Fragment values are merged in lexical filename order, independently of the global base config. */
export interface FragmentBundle { readonly config: Config.Info; readonly files: readonly string[] }

/** Provenance is a set of declared paths, never a comparison with fragment values. */
export interface ProjectSnapshot {
  readonly config: Config.Info
  readonly explicit: ReadonlySet<string>
  readonly policies: readonly Rule[]
  readonly disabledMCP: ReadonlySet<string>
  readonly permissions: readonly Rule[]
  readonly agentPermissions: ReadonlyMap<string, readonly Rule[]>
  readonly sources: readonly string[]
}

/** Explicit inputs keep discovery testable without mutating the running OpenCode environment. */
export interface DiscoveryOptions {
  readonly directory: string
  readonly globalDirectory: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/** Parse first, then substitute string values: quotes/newlines in credentials cannot corrupt JSON or inject keys. */
export async function parseConfigDocument(text: string, source: string, baseDirectory: string,
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<unknown> {
  const errors: ParseError[] = []
  const parsed: unknown = parseJSONC(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) throw new Error(`Invalid JSONC in ${source} at offset ${errors[0]!.offset}`)
  /** Process matches once; a secret containing another placeholder is never recursively expanded. */
  async function substitute(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      let result = ""
      let cursor = 0
      for (const match of value.matchAll(/\{(env|file):([^}]+)\}/g)) {
        result += value.slice(cursor, match.index)
        if (match[1] === "env") result += environment[match[2]!] ?? ""
        else {
          const ref = match[2]!
          const expanded = ref === "~" ? homedir() : ref.startsWith("~/") ? path.join(homedir(), ref.slice(2)) : ref
          const target = path.resolve(baseDirectory, expanded)
          try { result += (await readFile(target, "utf8")).trim() }
          catch { throw new Error(`Invalid file reference in ${source}: referenced file is not readable`) }
        }
        cursor = match.index + match[0].length
      }
      return result + value.slice(cursor)
    }
    if (Array.isArray(value)) return Promise.all(value.map(substitute))
    if (isRecord(value)) return Object.fromEntries(await Promise.all(Object.entries(value)
      .map(async ([key, item]) => [key, await substitute(item)])))
    return value
  }
  return substitute(parsed)
}

/** Load regular .json/.jsonc files (including uppercase extensions) in stable lexical order. */
export async function loadFragments(globalDirectory: string,
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<FragmentBundle> {
  const directory = path.join(globalDirectory, "config.d")
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { config: decodeConfig({}), files: [] }
    throw new Error(`Unable to read config.d directory: ${directory}`)
  }
  const files = entries.filter((entry) => entry.isFile() && /\.jsonc?$/i.test(entry.name))
    .map((entry) => entry.name).sort().map((name) => path.join(directory, name))
  let merged: unknown = {}
  for (const file of files) {
    const raw = await parseConfigDocument(await readFile(file, "utf8"), file, directory, environment)
    merged = mergeConfigValues(merged, normalizeSupportedDocument(raw, file, true).config)
  }
  return { config: decodeConfig(merged), files }
}

/** Canonicalize symlinks to avoid treating global configuration as project declarations. */
async function canonical(value: string): Promise<string> {
  try { return await realpath(value) } catch { return path.resolve(value) }
}

/** Test directory containment without confusing similarly prefixed sibling paths. */
function contains(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Enumerate ancestors from the filesystem root, not only the Git root. */
function ancestors(directory: string): string[] {
  const result: string[] = []
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    result.unshift(current)
    if (current === path.dirname(current)) return result
  }
}

/** Distinguish absent files from files that cannot be read. */
async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile() }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return false; throw error }
}

/** Recursively discover path-derived agent IDs in lexical order. */
async function markdownFiles(directory: string): Promise<string[]> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return []; throw error }
  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(file))
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) files.push(file)
  }
  return files
}

/** Parse native agent frontmatter; retain V1 compatibility without reinterpreting native request/permissions fields. */
export function parseAgentMarkdown(text: string, id: string, source: string, primary = false): unknown {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  let frontmatter: unknown = {}
  if (match) {
    try { frontmatter = parseYAML(match[1]!) ?? {} }
    catch {
      // Native Markdown also retries bare top-level scalars containing unquoted colons.
      const sanitized = match[1]!.split(/\r?\n/).flatMap((line) => {
        const entry = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line)
        const value = entry?.[2]?.trim()
        if (!entry || !value || value === ">" || value === "|" || /^["']/.test(value) || !value.includes(":")) return [line]
        return [`${entry[1]}: |-`, `  ${value}`]
      }).join("\n")
      try { frontmatter = parseYAML(sanitized) ?? {} }
      catch { throw new Error(`Invalid agent frontmatter in ${source}`) }
    }
  }
  if (!isRecord(frontmatter)) throw new Error(`Invalid agent frontmatter in ${source}: expected an object`)
  return agentMarkdownDocument(frontmatter, match ? match[2]! : text, id, primary)
}

/** Collect leaves and whole arrays; an empty map also explicitly protects its subtree. */
function collect(value: unknown, prefix: string, paths: Set<string>): void {
  if (!isRecord(value) || !Object.keys(value).length) { if (prefix) paths.add(prefix); return }
  for (const [key, child] of Object.entries(value)) collect(child, prefix ? `${prefix}.${key}` : key, paths)
}

/** Expand only path-based permission resources, as the native config-agent adapter does. */
export function expandRules(rules: readonly Rule[]): Rule[] {
  return rules.map((rule) => ["read", "edit", "external_directory"].includes(rule.action)
    ? { ...rule, resource: rule.resource.replace(/^(?:~|\$HOME)(?=$|[/\\])/, () => homedir()) } : { ...rule })
}

/** Reconstruct supported sources in native ordinary-setting order and reverse authority for policies. */
export async function discoverProjectConfig(options: DiscoveryOptions): Promise<ProjectSnapshot> {
  const environment = options.environment ?? process.env
  const global = await canonical(options.globalDirectory)
  const directory = path.resolve(options.directory)
  const documents: Array<{ source: string; document: Document }> = []
  /** Read once during setup, never from a replayable transform callback. */
  async function readSource(file: string): Promise<void> {
    const raw = await parseConfigDocument(await readFile(file, "utf8"), file, path.dirname(file), environment)
    documents.push({ source: file, document: normalizeSupportedDocument(raw, file) })
  }
  if (environment.OPENCODE_CONFIG) await readSource(path.resolve(directory, environment.OPENCODE_CONFIG))
  const disabled = environment.OPENCODE_DISABLE_PROJECT_CONFIG
  const directories = (!disabled || disabled === "0" || disabled === "false") && !contains(global, await canonical(directory))
    ? ancestors(directory) : []
  for (const ancestor of directories) for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = path.join(ancestor, name)
    if (await isFile(file) && !contains(global, await canonical(file))) await readSource(file)
  }
  for (const ancestor of directories) {
    const configDirectory = path.join(ancestor, ".opencode")
    if (contains(global, await canonical(configDirectory))) continue
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(configDirectory, name)
      if (await isFile(file)) await readSource(file)
    }
    for (const name of ["agent", "agents", "mode", "modes"]) {
      const agentDirectory = path.join(configDirectory, name)
      for (const file of await markdownFiles(agentDirectory)) {
        const id = path.relative(agentDirectory, file).slice(0, -3).split(path.sep).join("/")
        const raw = parseAgentMarkdown(await readFile(file, "utf8"), id, file, name === "mode" || name === "modes")
        documents.push({ source: file, document: normalizeSupportedDocument(raw, file) })
      }
    }
  }
  if (environment.OPENCODE_CONFIG_CONTENT !== undefined) {
    const source = "OPENCODE_CONFIG_CONTENT"
    const raw = await parseConfigDocument(environment.OPENCODE_CONFIG_CONTENT, source, directory, environment)
    documents.push({ source, document: normalizeSupportedDocument(raw, source) })
  }
  let merged: unknown = {}
  const explicit = new Set<string>()
  const permissions: Rule[] = []
  const agentPermissions = new Map<string, Rule[]>()
  const mcpStates = new Map<string, boolean>()
  for (const { document } of documents) {
    merged = mergeConfigValues(merged, document.config)
    collect(document.config, "", explicit)
    permissions.push(...expandRules(document.config.permissions ?? []))
    for (const [id, agent] of Object.entries(document.config.agents ?? {})) {
      agentPermissions.set(id, [...(agentPermissions.get(id) ?? []), ...expandRules(agent.permissions ?? [])])
    }
    for (const [providerID, provider] of Object.entries(document.config.providers ?? {})) {
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        const prefix = `providers.${providerID}.models.${id}`
        // These config declarations lower into differently named public runtime fields.
        if (model.releaseDate !== undefined) explicit.add(`${prefix}.time`)
        if (model.capabilities?.reasoning !== undefined) explicit.add(`${prefix}.variants`)
      }
    }
    for (const [name, disabled] of document.mcpActivation) {
      explicit.add(`mcp.servers.${name}.disabled`)
      mcpStates.set(name, disabled)
    }
  }
  return { config: decodeConfig(merged), explicit, permissions, agentPermissions,
    policies: documents.toReversed().flatMap(({ document }) => document.policies),
    disabledMCP: new Set([...mcpStates].filter(([, disabled]) => disabled).map(([name]) => name)),
    sources: documents.map(({ source }) => source) }
}

/** Protect declared leaves, arrays, and explicitly empty ancestor maps, even when values equal defaults. */
export function declared(snapshot: ProjectSnapshot, field: string): boolean {
  return [...snapshot.explicit].some((item) => item === field || item.startsWith(`${field}.`) || field.startsWith(`${item}.`))
}

/** Test an explicitly empty map (or another atomic declaration) that protects a whole subtree. */
export function protectedSubtree(snapshot: ProjectSnapshot, field: string): boolean {
  return [...snapshot.explicit].some((item) => item === field || field.startsWith(`${item}.`))
}

/** Match native whole-value policy wildcards, including the special trailing-space-star case. */
function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(value) || (pattern.endsWith(" *") && matches(pattern.slice(0, -2), value))
}

/** Policies are last-match-wins within a file, with broader files evaluated last. */
export function projectDenies(snapshot: ProjectSnapshot, action: string, resource: string): boolean {
  let result = false
  for (const rule of snapshot.policies) if (rule.action === action && matches(rule.resource, resource)) result = rule.effect === "deny"
  return result
}
