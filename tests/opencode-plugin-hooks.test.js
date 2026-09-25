/**
 * Tests for the published OpenCode hook plugin surface (V2 Plugin API).
 */

const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { pathToFileURL } = require("node:url")

const LOG_LEVELS = ["debug", "info", "warn", "error"]
const logs = []
const savedConsole = {}

function startLogCapture() {
  for (const level of LOG_LEVELS) {
    savedConsole[level] = console[level]
    console[level] = (message) => {
      logs.push({ level, message: String(message) })
    }
  }
}

function stopLogCapture() {
  for (const level of LOG_LEVELS) console[level] = savedConsole[level]
}

function hasMessage(level, needle) {
  return logs.some((entry) => entry.level === level && entry.message.includes(needle))
}

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`)
      return { passed: 1, failed: 0 }
    })
    .catch((error) => {
      console.log(`  ✗ ${name}`)
      console.error(`    ${error.stack || error.message}`)
      return { passed: 0, failed: 1 }
    })
}

// Let the plugin's microtask-scheduled work (lazy store import, event consumer) run.
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

let importCounter = 0
const pendingDisposes = []

function pluginUrl() {
  return pathToFileURL(
    path.join(__dirname, "..", ".opencode", "dist", "plugins", "ecc-hooks.js")
  ).href
}

function buildPlugin() {
  const repoRoot = path.join(__dirname, "..")
  const buildResult = spawnSync("node", [path.join(repoRoot, "scripts", "build-opencode.js")], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  assert.strictEqual(buildResult.status, 0, buildResult.stderr || buildResult.stdout)
}

function importPlugin() {
  // A fresh query string per import gives each test its own module instance, so the
  // plugin's duplicate-registration guard does not suppress the second setup() call.
  importCounter += 1
  return import(`${pluginUrl()}?instance=${importCounter}`)
}

function createContext(directory) {
  const handlers = { tool: {}, shell: {}, session: {}, permission: {} }
  const queue = []
  const waiters = []
  const state = { disposed: false }

  const register = (bucket) => async (name, handler) => {
    handlers[bucket][name] = handler
  }

  const ctx = {
    location: { directory },
    tool: { hook: register("tool") },
    shell: { hook: register("shell") },
    session: { hook: register("session") },
    permission: { hook: register("permission") },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return this
        },
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (state.disposed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        },
      }),
    },
  }

  const emit = async (event) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ value: event, done: false })
      await tick()
      return
    }
    queue.push(event)
  }

  return { ctx, handlers, emit, dispose: () => { state.disposed = true } }
}

async function setupPlugin(plugin, directory) {
  const context = createContext(directory)
  const dispose = await plugin.setup(context.ctx)
  pendingDisposes.push(() => {
    context.dispose()
    if (typeof dispose === "function") dispose()
  })
  await tick()
  return context
}

async function withTempProject(files, fn) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-plugin-"))
  try {
    for (const file of files) {
      const filePath = path.join(projectDir, file)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "")
    }
    return await fn(projectDir)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log("\n=== Testing OpenCode plugin hooks ===\n")

  buildPlugin()
  startLogCapture()

  const tests = [
    [
      "module exposes the V2 Plugin.define contract",
      async () => {
        const module = await importPlugin()
        const plugin = module.default
        assert.strictEqual(typeof plugin, "object", "Expected the default export to be an object")
        assert.strictEqual(plugin.id, "ecc-hooks")
        assert.strictEqual(typeof plugin.setup, "function", "Expected a setup() entry point")
        assert.strictEqual(module.ECCHooksPlugin, plugin, "Expected the named export to match")
      },
    ],
    [
      "hooks stay usable when plugins/lib is missing",
      async () => withTempProject([], async (projectDir) => {
        const libDir = path.join(__dirname, "..", ".opencode", "dist", "plugins", "lib")
        const backupDir = `${libDir}.missing-store-test-backup`
        fs.renameSync(libDir, backupDir)
        try {
          const { default: plugin } = await importPlugin()

          // Plugin initialization must resolve even though plugins/lib is missing --
          // it must not throw and crash session startup (#2530).
          const { handlers } = await setupPlugin(plugin, projectDir)
          await tick()

          assert.strictEqual(
            logs.filter(
              (entry) =>
                entry.level === "warn" &&
                entry.message.includes("[ECC] changed-files tracking disabled") &&
                entry.message.includes("ecc repair --target opencode")
            ).length,
            1,
            "Expected exactly one warning when plugins/lib/changed-files-store.js cannot be loaded"
          )

          // Every hook that touches the store must remain callable and must not throw.
          await handlers.tool["execute.before"]({ id: "1", tool: "write", input: { filePath: "src/example.ts" } })
          await handlers.tool["execute.after"]({ id: "1", tool: "edit", input: { filePath: "src/other.ts" } })
          assert.ok(handlers.permission.evaluate, "Expected the permission hook to be registered")
        } finally {
          fs.renameSync(backupDir, libDir)
        }
      }),
    ],
    [
      "changed-files tracking records and clears through the plugin hooks",
      async () => withTempProject([], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { handlers, emit } = await setupPlugin(plugin, projectDir)

        assert.ok(
          !hasMessage("warn", "changed-files tracking disabled"),
          "Did not expect a disabled warning when plugins/lib is present"
        )

        const storeUrl = pathToFileURL(
          path.join(__dirname, "..", ".opencode", "dist", "plugins", "lib", "changed-files-store.js")
        ).href
        const store = await import(storeUrl)

        await handlers.tool["execute.after"]({
          id: "1",
          tool: "edit",
          input: { filePath: "src/example.ts" },
        })
        assert.ok(
          store.getChangedPaths().some(
            (entry) =>
              entry.path === path.normalize("src/example.ts") && entry.changeType === "modified"
          ),
          "Expected the edit tool hook to record a change"
        )

        await handlers.tool["execute.after"]({
          id: "2",
          tool: "write",
          input: { filePath: "src/other.ts" },
        })
        assert.ok(
          store.getChangedPaths().some((entry) => entry.path === path.normalize("src/other.ts")),
          "Expected the write tool hook to record a change"
        )

        await emit({ type: "session.deleted" })
        assert.ok(!store.hasChanges(), "Expected session.deleted to clear tracked changes")
      }),
    ],
    [
      "filesystem.changed records creations and feeds the compaction edit list",
      async () => withTempProject([], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { handlers, emit } = await setupPlugin(plugin, projectDir)

        const storeUrl = pathToFileURL(
          path.join(__dirname, "..", ".opencode", "dist", "plugins", "lib", "changed-files-store.js")
        ).href
        const store = await import(storeUrl)

        await emit({ type: "filesystem.changed", data: { event: "add", file: "src/new.ts" } })
        assert.ok(
          store.getChangedPaths().some((entry) => entry.changeType === "added"),
          "Expected an added file to be recorded"
        )

        await emit({ type: "filesystem.changed", data: { event: "change", file: "src/edited.ts" } })
        const compaction = { system: [] }
        await handlers.session.compaction(compaction)
        const text = compaction.system.map((part) => part.text).join("\n")
        assert.ok(
          text.includes("src/edited.ts"),
          "Expected a changed file to reach the compaction edit list"
        )
      }),
    ],
    [
      "shell environment injects project markers",
      async () => withTempProject(
        ["pnpm-lock.yaml", "tsconfig.json", "pyproject.toml"],
        async (projectDir) => {
          const { default: plugin } = await importPlugin()
          const { handlers } = await setupPlugin(plugin, projectDir)

          const event = { env: { EXISTING_ENV: "preserved" } }
          await handlers.shell["create.before"](event)
          const { env } = event

          assert.strictEqual(env.EXISTING_ENV, "preserved")
          assert.strictEqual(env.PROJECT_ROOT, projectDir)
          assert.strictEqual(env.PACKAGE_MANAGER, "pnpm")
          assert.strictEqual(env.DETECTED_LANGUAGES, "typescript,python")
          assert.strictEqual(env.PRIMARY_LANGUAGE, "typescript")
          // Verify ECC_VERSION is not hardcoded
          assert.ok(env.ECC_VERSION !== "1.8.0", "ECC_VERSION should not be hardcoded to 1.8.0")
          assert.ok(env.ECC_VERSION.match(/^\d+\.\d+\.\d+$/), "ECC_VERSION should be a valid semver version")
        }
      ),
    ],
    [
      "session.created checks CLAUDE.md through fs",
      async () => withTempProject(["CLAUDE.md"], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { emit } = await setupPlugin(plugin, projectDir)

        await emit({ type: "session.created" })

        assert.ok(
          hasMessage("info", "[ECC] Found CLAUDE.md - loading project context"),
          "Expected CLAUDE.md detection log"
        )
      }),
    ],
    [
      "session.created ignores directories named CLAUDE.md",
      async () => {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-plugin-"))
        try {
          fs.mkdirSync(path.join(projectDir, "CLAUDE.md"))

          const { default: plugin } = await importPlugin()
          const { emit } = await setupPlugin(plugin, projectDir)

          await emit({ type: "session.created" })

          assert.ok(
            !hasMessage("info", "[ECC] Found CLAUDE.md - loading project context"),
            "Directory named CLAUDE.md should not be treated as project context"
          )
        } finally {
          fs.rmSync(projectDir, { recursive: true, force: true })
        }
      },
    ],
    [
      "shell environment ignores directories named like lockfiles and markers",
      async () => {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-plugin-"))
        try {
          fs.mkdirSync(path.join(projectDir, "pnpm-lock.yaml"))
          fs.mkdirSync(path.join(projectDir, "tsconfig.json"))

          const { default: plugin } = await importPlugin()
          const { handlers } = await setupPlugin(plugin, projectDir)

          const event = { env: {} }
          await handlers.shell["create.before"](event)
          const { env } = event

          assert.strictEqual(env.PROJECT_ROOT, projectDir)
          assert.ok(!("PACKAGE_MANAGER" in env), "Lockfile directory should not set PACKAGE_MANAGER")
          assert.ok(!("DETECTED_LANGUAGES" in env), "Marker directory should not set DETECTED_LANGUAGES")
          assert.ok(!("PRIMARY_LANGUAGE" in env), "Marker directory should not set PRIMARY_LANGUAGE")
        } finally {
          fs.rmSync(projectDir, { recursive: true, force: true })
        }
      },
    ],
    [
      "compaction appends ECC context without replacing host content",
      async () => withTempProject([], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { handlers } = await setupPlugin(plugin, projectDir)

        const event = { system: [{ type: "text", text: "Default compaction prompt" }] }
        await handlers.session.compaction(event)

        const text = event.system.map((part) => part.text).join("\n")
        assert.ok(
          event.system.some((part) => part.text.includes("Default compaction prompt")),
          "Expected the host prompt to be preserved"
        )
        assert.ok(text.includes("# ECC Context"), "Expected the ECC context block")
        assert.ok(
          text.includes("Current task status and progress"),
          "Expected the compaction focus guidance"
        )
      }),
    ],
    [
      "permission evaluate auto-approves read-only tools",
      async () => withTempProject([], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { handlers } = await setupPlugin(plugin, projectDir)

        for (const action of ["read", "glob", "grep"]) {
          const event = { action, resources: [] }
          await handlers.permission.evaluate(event)
          assert.strictEqual(event.effect, "allow", `Expected ${action} to be allowed`)
          assert.strictEqual(event.message, "Read-only operation")
        }
      }),
    ],
    [
      "permission evaluate auto-approves formatters",
      async () => withTempProject([], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { handlers } = await setupPlugin(plugin, projectDir)

        for (const command of [
          "npx prettier --write src/index.ts",
          "npx @biomejs/biome format --write src/index.ts",
        ]) {
          const event = { action: "bash", resources: [command] }
          await handlers.permission.evaluate(event)
          assert.strictEqual(event.effect, "allow", `Expected ${command} to be allowed`)
          assert.strictEqual(event.message, "Formatter execution")
        }
      }),
    ],
    [
      "permission evaluate auto-approves test execution",
      async () => withTempProject([], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { handlers } = await setupPlugin(plugin, projectDir)

        for (const command of ["npm test", "npx vitest run"]) {
          const event = { action: "bash", resources: [command] }
          await handlers.permission.evaluate(event)
          assert.strictEqual(event.effect, "allow", `Expected ${command} to be allowed`)
          assert.strictEqual(event.message, "Test execution")
        }
      }),
    ],
    [
      "permission evaluate leaves other actions for the user",
      async () => withTempProject([], async (projectDir) => {
        const { default: plugin } = await importPlugin()
        const { handlers } = await setupPlugin(plugin, projectDir)

        const event = { action: "bash", resources: ["rm -rf /"] }
        await handlers.permission.evaluate(event)

        assert.notStrictEqual(event.effect, "allow", "Expected destructive commands to stay unapproved")
      }),
    ],
  ]

  let passed = 0
  let failed = 0
  for (const [name, fn] of tests) {
    logs.length = 0
    const result = await runTest(name, fn)
    passed += result.passed
    failed += result.failed
  }

  for (const dispose of pendingDisposes) dispose()
  stopLogCapture()

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
