/**
 * ECC Plugin Hooks for OpenCode
 *
 * ## Active Plugin: ECC v2.2.2
 *
 * This plugin translates Claude Code hooks to OpenCode's V2 plugin API.
 *
 * Hook Event Mapping:
 * - PreToolUse -> ctx.tool.hook("execute.before")
 * - PostToolUse -> ctx.tool.hook("execute.after")
 * - Stop -> ctx.event.subscribe() on "session.idle"
 * - SessionStart -> ctx.event.subscribe() on "session.created"
 * - SessionEnd -> ctx.event.subscribe() on "session.deleted"
 * - ShellEnv -> ctx.shell.hook("create.before")
 * - Compaction -> ctx.session.hook("compaction")
 * - PermissionAsk -> ctx.permission.hook("evaluate")
 */

import { Plugin } from "@opencode/plugin"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Type definitions for better type safety
 */
interface ToolArgs {
  filePath?: string
  file_path?: string
  path?: string
  command?: string
  [key: string]: unknown
}

type HookProfile = "minimal" | "standard" | "strict"
type ChangeKind = "added" | "modified" | "deleted"
type LogLevel = "debug" | "info" | "warn" | "error"

const FALLBACK_ECC_VERSION = "2.0.0"
const JAVASCRIPT_PATTERN = /\.(ts|tsx|js|jsx)$/
const TYPESCRIPT_PATTERN = /\.tsx?$/
const DOC_FILE_PATTERN = /\.(md|txt)$/i
const PRESERVED_DOC_NAMES = ["README", "CHANGELOG", "LICENSE", "CONTRIBUTING"]
const READ_ONLY_TOOLS = ["read", "glob", "grep", "search", "list"]
const FORMATTER_PATTERN = /^(npx )?(@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)/
const TEST_COMMAND_PATTERN = /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)/
const LONG_RUNNING_PATTERNS = [
  /^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/,
  /^cargo\s+(build|test|run)/,
  /^go\s+(build|test|run)/,
]
const LOCKFILES: Record<string, string> = {
  "bun.lockb": "bun",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
}
const LANG_DETECTORS: Record<string, string> = {
  "tsconfig.json": "typescript",
  "go.mod": "go",
  "pyproject.toml": "python",
  "Cargo.toml": "rust",
  "Package.swift": "swift",
}

/**
 * Read ECC version from package.json
 * Falls back to a default if package.json cannot be read
 */
function getECCVersion(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url)
    const packageJson = JSON.parse(fs.readFileSync(packageJsonUrl, "utf-8"))
    return packageJson.version || FALLBACK_ECC_VERSION
  } catch {
    return FALLBACK_ECC_VERSION
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * OpenCode resolves this module through several entrypoints (the plugins
 * directory, its index barrel, and the `plugin` config entry), so registration
 * is guarded to keep the hooks from being wired up more than once.
 */
let isRegistered = false

export const ECCHooksPlugin = Plugin.define({
  id: "ecc-hooks",
  async setup(ctx) {
    if (isRegistered) return
    isRegistered = true

    const worktreePath = ctx.location.directory

    const editedFiles = new Set<string>()
    const pendingToolChanges = new Map<string, { path: string; type: ChangeKind }>()
    let writeCounter = 0

    const log = (level: LogLevel, message: string) => {
      const line = `[ECC] ${message}`
      if (level === "error") console.error(line)
      else if (level === "warn") console.warn(line)
      else if (level === "debug") console.debug(line)
      else console.info(line)
    }

    // Loaded lazily for the same reason as the changed-files store below: a
    // missing `plugins/lib` directory must not throw during module evaluation,
    // because this module is OpenCode's startup entry point (#2530). Every caller
    // of `run` already handles rejection, so a failed import just degrades the
    // subprocess-backed hooks instead of crashing the session.
    let runProcess: typeof import("./lib/process.ts")["runProcess"] | undefined
    const run = async (
      command: string,
      args: readonly string[]
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (!runProcess) {
        const process = await import("./lib/process.ts")
        runProcess = process.runProcess
      }
      return runProcess(command, args, { cwd: worktreePath })
    }

    const resolvePath = (target: string): string =>
      path.isAbsolute(target) ? target : path.join(worktreePath, target)

    const hasProjectFile = (relativePath: string): boolean => {
      try {
        return fs.statSync(resolvePath(relativePath)).isFile()
      } catch {
        return false
      }
    }

    const getFilePath = (args: ToolArgs | undefined): string | null => {
      if (!args) return null
      const candidate = args.filePath ?? args.file_path ?? args.path
      return typeof candidate === "string" && candidate.trim() ? candidate : null
    }

    // Loaded lazily (instead of via a top-level import) so that a missing or
    // partially-installed `~/.opencode/plugins/lib` directory (e.g. an
    // interrupted or partial ECC install on Termux/Android) only disables
    // changed-files tracking, rather than throwing during module evaluation.
    // This plugin is OpenCode's startup entry point, so a static import
    // failure here previously crashed the whole plugin -- and with it, the
    // entire OpenCode session -- before any hooks could load (see #2530).
    let changedFilesStore: typeof import("./lib/changed-files-store.ts") | undefined
    try {
      const store = await import("./lib/changed-files-store.ts")
      store.initStore(worktreePath)
      changedFilesStore = store
    } catch {
      // Best-effort diagnostic only: the raw loader error is intentionally not
      // included in the message since it can contain absolute filesystem
      // paths; this whole block exists to guarantee startup resilience even
      // when things go wrong.
      Promise.resolve()
        .then(() =>
          log(
            "warn",
            "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
              "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
          )
        )
        .catch(() => {})
    }

    const normalizeProfile = (value: string | undefined): HookProfile => {
      if (value === "minimal" || value === "strict") return value
      return "standard"
    }

    const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
    const disabledHooks = new Set(
      (process.env.ECC_DISABLED_HOOKS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )

    const profileOrder: Record<HookProfile, number> = {
      minimal: 0,
      standard: 1,
      strict: 2,
    }

    const profileAllowed = (required: HookProfile | HookProfile[]): boolean => {
      if (Array.isArray(required)) {
        return required.some((entry) => profileOrder[currentProfile] >= profileOrder[entry])
      }
      return profileOrder[currentProfile] >= profileOrder[required]
    }

    const hookEnabled = (
      hookId: string,
      requiredProfile: HookProfile | HookProfile[] = "standard"
    ): boolean => {
      if (disabledHooks.has(hookId)) return false
      return profileAllowed(requiredProfile)
    }

    /**
     * Prettier Auto-Format Hook
     * Equivalent to Claude Code PostToolUse hook for prettier
     *
     * Triggers: After any JS/TS/JSX/TSX file is edited
     * Action: Runs prettier --write on the file
     */
    const handleFileEdited = async (filePath: string): Promise<void> => {
      editedFiles.add(filePath)
      changedFilesStore?.recordChange(filePath, "modified")

      if (hookEnabled("post:edit:format", ["strict"]) && JAVASCRIPT_PATTERN.test(filePath)) {
        try {
          await run("prettier", ["--write", filePath])
          log("info", `Formatted: ${filePath}`)
        } catch (error: unknown) {
          // Prettier not installed or failed - log but continue
          log("debug", `Prettier formatting failed for ${filePath}: ${describeError(error)}`)
        }
      }

      if (
        hookEnabled("post:edit:console-warn", ["standard", "strict"]) &&
        JAVASCRIPT_PATTERN.test(filePath)
      ) {
        try {
          const result = await run("grep", ["-n", "console\\.log", filePath])
          if (result.stdout.trim()) {
            const lines = result.stdout.trim().split("\n").length
            log(
              "warn",
              `console.log found in ${filePath} (${lines} occurrence${lines > 1 ? "s" : ""})`
            )
          }
        } catch {
          // No console.log found (grep returns non-zero) - this is good
        }
      }
    }

    /**
     * Session Idle Hook
     * Equivalent to Claude Code Stop hook
     *
     * Triggers: When session becomes idle (task completed)
     * Action: Runs console.log audit on all edited files
     */
    const runConsoleLogAudit = async (): Promise<void> => {
      if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
      if (editedFiles.size === 0) return

      log("info", "Session idle - running console.log audit")

      let totalConsoleLogCount = 0
      const filesWithConsoleLogs: string[] = []

      for (const file of editedFiles) {
        if (!JAVASCRIPT_PATTERN.test(file)) continue

        try {
          const result = await run("grep", ["-c", "console\\.log", file])
          const count = parseInt(result.stdout.trim(), 10)
          if (count > 0) {
            totalConsoleLogCount += count
            filesWithConsoleLogs.push(file)
          }
        } catch {
          // No console.log found
        }
      }

      if (totalConsoleLogCount === 0) {
        log("info", "Audit passed: No console.log statements found")
        return
      }

      log(
        "warn",
        `Audit: ${totalConsoleLogCount} console.log statement(s) in ${filesWithConsoleLogs.length} file(s)`
      )
      filesWithConsoleLogs.forEach((file) => log("warn", `  - ${file}`))
      log("warn", "Remove console.log statements before committing")
    }

    const notifyTaskComplete = async (): Promise<void> => {
      try {
        if (process.platform === "darwin") {
          await run("osascript", [
            "-e",
            'display notification "Task completed!" with title "OpenCode ECC"',
          ])
        } else if (process.platform === "win32") {
          await run("powershell", [
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')",
          ])
        } else if (process.platform === "linux") {
          await run("notify-send", ["OpenCode ECC", "Task completed!"])
        }
      } catch (error: unknown) {
        // Notification not supported or failed - log but continue
        log("debug", `Desktop notification failed: ${describeError(error)}`)
      }
    }

    /**
     * Pre-Tool Security Check
     * Equivalent to Claude Code PreToolUse hook
     *
     * Triggers: Before tool execution
     * Action: Warns about potential security issues
     */
    await ctx.tool.hook("execute.before", async (event) => {
      const args = event.input as ToolArgs | undefined

      if (event.tool === "write") {
        const filePath = getFilePath(args)
        if (filePath) {
          const type: ChangeKind = fs.existsSync(resolvePath(filePath)) ? "modified" : "added"
          pendingToolChanges.set(event.id, { path: filePath, type })
        }
      }

      const command = typeof args?.command === "string" ? args.command : ""

      if (
        hookEnabled("pre:bash:git-push-reminder", "strict") &&
        event.tool === "bash" &&
        command.includes("git push")
      ) {
        log("info", "Remember to review changes before pushing: git diff origin/main...HEAD")
      }

      const writtenPath = args?.filePath
      const isUnnecessaryDoc =
        hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) &&
        event.tool === "write" &&
        typeof writtenPath === "string" &&
        DOC_FILE_PATTERN.test(writtenPath) &&
        !PRESERVED_DOC_NAMES.some((name) => writtenPath.includes(name))
      if (isUnnecessaryDoc) {
        log("warn", `Creating ${writtenPath} - consider if this documentation is necessary`)
      }

      if (
        hookEnabled("pre:bash:tmux-reminder", "strict") &&
        event.tool === "bash" &&
        LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(command))
      ) {
        log("info", "Long-running command detected - consider using background execution")
      }
    })

    /**
     * TypeScript Check Hook
     * Equivalent to Claude Code PostToolUse hook for tsc
     *
     * Triggers: After edit tool completes on .ts/.tsx files
     * Action: Runs tsc --noEmit to check for type errors
     */
    await ctx.tool.hook("execute.after", async (event) => {
      const args = event.input as ToolArgs | undefined
      const filePath = getFilePath(args)

      if (event.tool === "edit" && filePath) {
        changedFilesStore?.recordChange(filePath, "modified")
      }
      if (event.tool === "write" && filePath) {
        const pending = pendingToolChanges.get(event.id)
        if (pending) {
          changedFilesStore?.recordChange(pending.path, pending.type)
          pendingToolChanges.delete(event.id)
        } else {
          changedFilesStore?.recordChange(filePath, "modified")
        }
      }

      if (
        hookEnabled("post:edit:typecheck", ["strict"]) &&
        event.tool === "edit" &&
        filePath &&
        TYPESCRIPT_PATTERN.test(filePath)
      ) {
        try {
          await run("npx", ["tsc", "--noEmit"])
          log("info", "TypeScript check passed")
        } catch (error: unknown) {
          log("warn", "TypeScript errors detected:")
          const stdout = (error as { stdout?: string }).stdout
          if (stdout) {
            stdout.split("\n").slice(0, 5).forEach((line: string) => log("warn", `  ${line}`))
          }
        }
      }

      if (
        hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
        event.tool === "bash" &&
        typeof args?.command === "string" &&
        args.command.includes("gh pr create")
      ) {
        log("info", "PR created - check GitHub Actions status")
      }
    })

    /**
     * Shell Environment Hook
     * Injects environment variables into shell commands
     *
     * Triggers: Before shell command execution
     * Action: Sets PROJECT_ROOT, PACKAGE_MANAGER, DETECTED_LANGUAGES, ECC_VERSION
     */
    await ctx.shell.hook("create.before", (event) => {
      const env: Record<string, string> = {
        ECC_VERSION: getECCVersion(),
        ECC_PLUGIN: "true",
        ECC_HOOK_PROFILE: currentProfile,
        ECC_DISABLED_HOOKS: process.env.ECC_DISABLED_HOOKS || "",
        PROJECT_ROOT: worktreePath,
      }

      for (const [lockfile, packageManager] of Object.entries(LOCKFILES)) {
        if (hasProjectFile(lockfile)) {
          env.PACKAGE_MANAGER = packageManager
          break
        }
      }

      const detected = Object.entries(LANG_DETECTORS)
        .filter(([file]) => hasProjectFile(file))
        .map(([, language]) => language)
      if (detected.length > 0) {
        env.DETECTED_LANGUAGES = detected.join(",")
        env.PRIMARY_LANGUAGE = detected[0]
      }

      Object.assign(event.env, env)
    })

    /**
     * Session Compacting Hook
     *
     * Triggers: Before context compaction
     * Action: Pushes an ECC context block and a custom compaction prompt
     */
    await ctx.session.hook("compaction", (event) => {
      const contextBlock = [
        "# ECC Context (preserve across compaction)",
        "",
        `## Active Plugin: ECC v${getECCVersion()}`,
        "- Hooks: tool.execute.before/after, session.created/idle/deleted, shell.env, compaction, permission",
        "- Tools: run-tests, check-coverage, security-audit, format-code, lint-check, git-summary, changed-files",
        "- Agents: 13 specialized (planner, architect, tdd-guide, code-reviewer, security-reviewer, build-error-resolver, e2e-runner, refactor-cleaner, doc-updater, go-reviewer, go-build-resolver, database-reviewer, python-reviewer)",
        "",
        "## Key Principles",
        "- TDD: write tests first, 80%+ coverage",
        "- Immutability: never mutate, always return new copies",
        "- Security: validate inputs, no hardcoded secrets",
        "",
      ]

      if (editedFiles.size > 0) {
        contextBlock.push("## Recently Edited Files")
        for (const file of editedFiles) {
          contextBlock.push(`- ${file}`)
        }
        contextBlock.push("")
      }

      event.system.push({ type: "text", text: contextBlock.join("\n") })
      event.system.push({
        type: "text",
        text: "Focus on preserving: 1) Current task status and progress, 2) Key decisions made, 3) Files created/modified, 4) Remaining work items, 5) Any security concerns flagged. Discard: verbose tool outputs, intermediate exploration, redundant file listings.",
      })
    })

    /**
     * Permission Auto-Approve Hook
     *
     * Triggers: When a permission is evaluated
     * Action: Auto-approves reads, formatters, and test commands; logs the rest
     */
    await ctx.permission.hook("evaluate", (event) => {
      const command = event.resources.join(" ")
      const approve = (reason: string) => {
        event.effect = "allow"
        event.message = reason
        log("debug", `Auto-approved ${event.action}: ${reason}`)
      }

      if (READ_ONLY_TOOLS.includes(event.action)) {
        approve("Read-only operation")
        return
      }
      if (event.action === "bash" && FORMATTER_PATTERN.test(command)) {
        approve("Formatter execution")
        return
      }
      if (event.action === "bash" && TEST_COMMAND_PATTERN.test(command)) {
        approve("Test execution")
        return
      }

      log("debug", `Permission requires user approval: ${event.action}`)
    })

    /**
     * File Watcher / Session Lifecycle Hooks
     * Subscribes to the V2 event stream
     */
    const eventController = new AbortController()
    const consumeEvents = async (): Promise<void> => {
      for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
        if (event.type === "filesystem.changed") {
          if (event.data.event === "change") {
            await handleFileEdited(event.data.file)
            continue
          }
          const changeKind: ChangeKind = event.data.event === "add" ? "added" : "deleted"
          changedFilesStore?.recordChange(event.data.file, changeKind)
          continue
        }

        if (event.type === "session.created") {
          if (!hookEnabled("session:start", ["minimal", "standard", "strict"])) continue
          log("info", `Session started - profile=${currentProfile}`)
          if (hasProjectFile("CLAUDE.md")) {
            log("info", "Found CLAUDE.md - loading project context")
          }
          continue
        }

        if (event.type === "session.idle") {
          await runConsoleLogAudit()
          await notifyTaskComplete()
          editedFiles.clear()
          continue
        }

        if (event.type === "session.deleted") {
          if (!hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) continue
          log("info", "Session ended - cleaning up")
          editedFiles.clear()
          changedFilesStore?.clearChanges()
          pendingToolChanges.clear()
        }
      }
    }

    void consumeEvents().catch((error: unknown) => {
      if (!eventController.signal.aborted) {
        log("warn", `Event stream ended unexpectedly: ${describeError(error)}`)
      }
    })

    return () => eventController.abort()
  },
})

export default ECCHooksPlugin

// vim:set ai et sts=2 sw=2
