/**
 * Continuous Learning v2 - OpenCode V2 observation bridge.
 *
 * Observation remains best-effort so continuous learning can never block a tool.
 */
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  runProcess,
  type ProcessOptions,
  type ProcessResult,
} from "./lib/process.ts"

const OBSERVE_SCRIPT = path.join(
  process.env.HOME ?? "",
  ".config",
  "opencode",
  "skills",
  "continuous-learning-v2",
  "hooks",
  "observe.sh",
)

export type ObservationPhase = "pre" | "post"

export interface ToolObservation {
  tool: string
  input: unknown
  callID: string
  output?: unknown
}

interface ProcessRequest extends ProcessOptions {
  command: string
  args: readonly string[]
}

export type ObservationRunner = (request: ProcessRequest) => Promise<ProcessResult>

export interface ObservationContext {
  cwd: string
  observeScript: string
  runner: ObservationRunner
  shouldSkip: boolean
}

export interface ObservationContextOptions {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  observeScript: string
  runner?: ObservationRunner
}

async function runObservationProcess(request: ProcessRequest): Promise<ProcessResult> {
  const { command, args, ...options } = request
  return runProcess(command, args, options)
}

export function createObservationContext(options: ObservationContextOptions): ObservationContext {
  return {
    cwd: options.cwd,
    observeScript: options.observeScript,
    runner: options.runner ?? runObservationProcess,
    shouldSkip: options.env.ECC_SKIP_OBSERVE === "1",
  }
}

function serializeObservation(observation: ToolObservation, context: ObservationContext, phase: ObservationPhase): string | null {
  try {
    return JSON.stringify({
      tool_name: observation.tool,
      tool_input: observation.input ?? {},
      tool_use_id: observation.callID,
      cwd: context.cwd,
      ...(phase === "post" ? { output: observation.output ?? "" } : {}),
    })
  } catch {
    return null
  }
}

export async function observeToolCall(
  observation: ToolObservation,
  context: ObservationContext,
  phase: ObservationPhase,
): Promise<void> {
  if (context.shouldSkip) return

  const input = serializeObservation(observation, context, phase)
  if (input === null) return

  try {
    await context.runner({
      command: "bash",
      args: [context.observeScript, phase],
      cwd: context.cwd,
      input,
    })
  } catch {
    return
  }
}

export const CLv2Observe = Plugin.define({
  id: "ecc-continuous-learning-v2",
  async setup(ctx) {
    const observationContext = createObservationContext({
      cwd: ctx.location.directory,
      env: process.env,
      observeScript: OBSERVE_SCRIPT,
    })

    await ctx.tool.hook("execute.before", async (event) => {
      await observeToolCall({
        tool: event.tool,
        input: event.input,
        callID: event.id,
      }, observationContext, "pre")
    })

    await ctx.tool.hook("execute.after", async (event) => {
      await observeToolCall({
        tool: event.tool,
        input: event.input,
        callID: event.id,
        output: event.status === "completed" ? event.result : event.error,
      }, observationContext, "post")
    })
  },
})

export default CLv2Observe

// vim:set ai et sts=2 sw=2
