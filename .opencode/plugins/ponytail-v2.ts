/**
 * OpenCode V2 adapter for Ponytail 4.10.0.
 *
 * Ponytail's published OpenCode entrypoint still uses the V1 plugin API. This
 * adapter reuses the package's instruction, mode, and command helpers while
 * registering their behavior through the V2 plugin domains.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { Plugin, Skill } from "@opencode/plugin"
import type { CommandEditor, CommandInvocation } from "@opencode/plugin/promise/command"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { SkillEditor } from "@opencode/plugin/promise/skill"

const PONYTAIL_PACKAGE = "@dietrichgebert/ponytail"
const COMMAND_DIRECTORY = path.join(".opencode", "command")
const CONFIG_HELPER = path.join("hooks", "ponytail-config.js")
const FRONTMATTER_HELPER = path.join(".opencode", "plugins", "ponytail-frontmatter.cjs")
const INSTRUCTIONS_HELPER = path.join("hooks", "ponytail-instructions.js")
const SKILL_FILE = "SKILL.md"
const SKILL_DIRECTORY = "skills"
const STATE_FILE = ".ponytail-active"
const SWITCH_COMMAND = "ponytail"
const ARGUMENTS_TOKEN = "$ARGUMENTS"
const PONYTAIL_MODES = ["off", "lite", "full", "ultra", "review"] as const

type PonytailMode = (typeof PONYTAIL_MODES)[number]

interface PonytailCommand {
  name: string
  description?: string
  template: string
}

interface PonytailConfigHelpers {
  getDefaultMode(): unknown
  normalizePersistedMode(value: unknown): unknown
}

interface PonytailInstructionHelpers {
  getPonytailInstructions(mode: PonytailMode): unknown
}

interface PonytailFrontmatterHelpers {
  parseCommandFile(filePath: string): unknown
}

interface PonytailRuntime {
  getDefaultMode(): PonytailMode
  normalizeMode(value: string): PonytailMode | null
  readMode(): PonytailMode
  writeMode(mode: PonytailMode): void
  createInstructions(mode: PonytailMode): string
  prompt(input: CommandInvocation, template: string, args: string): Promise<void>
}

interface RuntimeOptions {
  context: Context
  root: string
}

interface CommandRegistrationOptions {
  root: string
  runtime: PonytailRuntime
}

const require = createRequire(import.meta.url)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPonytailMode(value: unknown): value is PonytailMode {
  return typeof value === "string" && PONYTAIL_MODES.includes(value as PonytailMode)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function requirePonytailMode(value: unknown, source: string): PonytailMode {
  if (isPonytailMode(value)) return value
  throw new Error(`ponytail: ${source} returned an invalid mode`)
}

function resolvePonytailRoot(): string {
  try {
    const entryPath = require.resolve(PONYTAIL_PACKAGE)
    return path.resolve(path.dirname(entryPath), "..", "..")
  } catch (error) {
    throw new Error(`ponytail: cannot resolve ${PONYTAIL_PACKAGE}`, { cause: error })
  }
}

function loadConfigHelpers(root: string): PonytailConfigHelpers {
  const modulePath = path.join(root, CONFIG_HELPER)
  const moduleValue: unknown = require(modulePath)
  if (!isRecord(moduleValue)) throw new Error(`ponytail: invalid config helper at ${modulePath}`)
  return {
    getDefaultMode: moduleValue["getDefaultMode"] as () => unknown,
    normalizePersistedMode: moduleValue["normalizePersistedMode"] as (value: unknown) => unknown,
  }
}

function loadInstructionHelpers(root: string): PonytailInstructionHelpers {
  const modulePath = path.join(root, INSTRUCTIONS_HELPER)
  const moduleValue: unknown = require(modulePath)
  if (!isRecord(moduleValue)) throw new Error(`ponytail: invalid instruction helper at ${modulePath}`)
  return {
    getPonytailInstructions: moduleValue["getPonytailInstructions"] as (mode: PonytailMode) => unknown,
  }
}

function loadFrontmatterHelpers(root: string): PonytailFrontmatterHelpers {
  const modulePath = path.join(root, FRONTMATTER_HELPER)
  const moduleValue: unknown = require(modulePath)
  if (!isRecord(moduleValue)) throw new Error(`ponytail: invalid frontmatter helper at ${modulePath}`)
  return { parseCommandFile: moduleValue["parseCommandFile"] as (filePath: string) => unknown }
}

function getStatePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(configHome, "opencode", STATE_FILE)
}

function readStateMode(normalizeMode: (value: unknown) => unknown, fallback: () => PonytailMode): PonytailMode {
  try {
    const persisted = normalizeMode(fs.readFileSync(getStatePath(), "utf8").trim())
    return isPonytailMode(persisted) ? persisted : fallback()
  } catch (error) {
    if (isMissingFile(error)) return fallback()
    throw new Error("ponytail: cannot read active mode", { cause: error })
  }
}

function writeStateMode(mode: PonytailMode): void {
  const statePath = getStatePath()
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, mode, "utf8")
}

function renderCommandPrompt(template: string, args: string): string {
  return template.replaceAll(ARGUMENTS_TOKEN, args)
}

async function promptCommand(
  context: Context,
  input: CommandInvocation,
  template: string,
): Promise<void> {
  await context.session.prompt({
    sessionID: input.sessionID,
    text: renderCommandPrompt(template, input.prompt.text.trim()),
    delivery: input.delivery,
  })
}

function createRuntime(options: RuntimeOptions): PonytailRuntime {
  const config = loadConfigHelpers(options.root)
  const instructions = loadInstructionHelpers(options.root)
  const getDefaultMode = (): PonytailMode => requirePonytailMode(config.getDefaultMode(), "default mode resolver")
  const normalizeMode = (value: string): PonytailMode | null => {
    const normalized = config.normalizePersistedMode(value)
    return isPonytailMode(normalized) ? normalized : null
  }
  return {
    getDefaultMode,
    normalizeMode,
    readMode: () => readStateMode(config.normalizePersistedMode, getDefaultMode),
    writeMode: writeStateMode,
    createInstructions(mode) {
      const text = instructions.getPonytailInstructions(mode)
      if (typeof text !== "string") throw new Error("ponytail: instruction helper returned invalid text")
      return text
    },
    prompt: (input, template) => promptCommand(options.context, input, template),
  }
}

function parseCommand(value: unknown, name: string): PonytailCommand | null {
  if (!isRecord(value) || typeof value["template"] !== "string") return null
  const description = value["description"]
  return {
    name,
    template: value["template"],
    ...(typeof description === "string" ? { description } : {}),
  }
}

function readCommands(root: string, helpers: PonytailFrontmatterHelpers): PonytailCommand[] {
  const directory = path.join(root, COMMAND_DIRECTORY)
  const commands: PonytailCommand[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".md") continue
    const name = path.basename(entry.name, ".md")
    const command = parseCommand(helpers.parseCommandFile(path.join(directory, entry.name)), name)
    if (command) commands.push(command)
  }
  return commands
}

async function executeCommand(
  command: PonytailCommand,
  input: CommandInvocation,
  runtime: PonytailRuntime,
): Promise<void> {
  const args = input.prompt.text.trim()
  if (command.name === SWITCH_COMMAND) {
    const mode = args ? runtime.normalizeMode(args) : runtime.getDefaultMode()
    if (mode) {
      runtime.writeMode(mode)
      console.info(`[ponytail] mode=${mode}`)
    }
  }
  await runtime.prompt(input, command.template, args)
}

function registerCommands(editor: CommandEditor, options: CommandRegistrationOptions): void {
  const helpers = loadFrontmatterHelpers(options.root)
  for (const command of readCommands(options.root, helpers)) {
    editor.add({
      name: command.name,
      description: command.description,
      execute: (input) => executeCommand(command, input, options.runtime),
    })
  }
}

function parseFrontmatter(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? ""
}

function parseSkillName(frontmatter: string, fallback: string): string {
  const value = frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim().replace(/^['"]|['"]$/gu, "")
  return value || fallback
}

function parseSkillDescription(frontmatter: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/u)
  const start = lines.findIndex((line) => /^description:\s*(.*)$/u.test(line))
  if (start < 0) return undefined
  const firstValue = lines[start]?.match(/^description:\s*(.*)$/u)?.[1]?.trim() ?? ""
  const parts = firstValue === ">" || firstValue === "|" ? [] : [firstValue]
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/u.test(line)) break
    parts.push(line.trim())
  }
  const description = parts.join(" ").replace(/^['"]|['"]$/gu, "").trim()
  return description || undefined
}

function createSkillDefinition(skillPath: string, content: string, fallbackName: string): Skill.Info {
  const frontmatter = parseFrontmatter(content)
  const description = parseSkillDescription(frontmatter)
  return {
    id: Skill.ID.make(fallbackName),
    name: Skill.Name.make(parseSkillName(frontmatter, fallbackName)),
    path: skillPath as Skill.Info["path"],
    content,
    ...(description ? { description } : {}),
  }
}

function registerSkills(editor: SkillEditor, root: string): void {
  const directory = path.join(root, SKILL_DIRECTORY)
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillPath = path.join(directory, entry.name, SKILL_FILE)
    if (!fs.existsSync(skillPath)) continue
    editor.add(createSkillDefinition(skillPath, fs.readFileSync(skillPath, "utf8"), entry.name))
  }
}

function appendInstructions(request: SessionContext, runtime: PonytailRuntime): void {
  const mode = runtime.readMode()
  if (mode === "off") return
  const instructions = runtime.createInstructions(mode)
  const lastIndex = request.system.length - 1
  const lastPart = request.system[lastIndex]
  if (!lastPart) {
    request.system.push({ type: "text", text: instructions })
    return
  }
  request.system[lastIndex] = { ...lastPart, text: `${lastPart.text}\n\n${instructions}` }
}

const PonytailV2 = Plugin.define({
  id: "ponytail",
  async setup(ctx) {
    const root = resolvePonytailRoot()
    if (!fs.existsSync(path.join(root, CONFIG_HELPER))) {
      throw new Error("ponytail: package layout is incompatible with this adapter")
    }
    const runtime = createRuntime({ context: ctx, root })
    const commandRegistration = await ctx.command.transform((editor) => registerCommands(editor, { root, runtime }))
    const skillRegistration = await ctx.skill.transform((editor) => registerSkills(editor, root))
    const sessionRegistration = await ctx.session.hook("context", (request) => appendInstructions(request, runtime))
    return async () => {
      await commandRegistration.dispose()
      await skillRegistration.dispose()
      await sessionRegistration.dispose()
    }
  },
})

export default PonytailV2

// vim:set ai et sts=2 sw=2
