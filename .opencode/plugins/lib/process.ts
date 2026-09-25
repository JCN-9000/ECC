import { spawn } from "node:child_process"

export interface ProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  signal?: AbortSignal
}

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface ProcessFailure {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export class ProcessError extends Error {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string

  constructor(message: string, failure: ProcessFailure) {
    super(message)
    this.name = "ProcessError"
    this.exitCode = failure.exitCode
    this.signal = failure.signal
    this.stdout = failure.stdout
    this.stderr = failure.stderr
  }
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    // A child that exits before reading its stdin (or an aborted child tearing
    // down its pipes) makes these sockets emit EPIPE. Without a listener that
    // becomes an unhandled 'error' event and takes the whole process down, so
    // the pipe errors are swallowed here; the exit code carries the real failure.
    child.stdin.on("error", () => {})
    child.stdout.on("error", () => {})
    child.stderr.on("error", () => {})
    child.once("error", reject)
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve({ exitCode, stdout, stderr })
        return
      }
      reject(new ProcessError(`${command} exited with code ${exitCode}`, {
        exitCode,
        signal,
        stdout,
        stderr,
      }))
    })

    child.stdin.end(options.input ?? "")
  })
}

// vim:set ai et sts=2 sw=2
