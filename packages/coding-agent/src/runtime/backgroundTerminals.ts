import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";

export interface BackgroundTerminalSession {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  status: "running" | "exited" | "failed";
  output: string;
}

const MAX_OUTPUT_CHARS = 12000;

class BackgroundTerminalManager {
  private sessions = new Map<string, BackgroundTerminalSession>();
  private processes = new Map<
    string,
    ChildProcessByStdio<null, Readable, Readable>
  >();

  start(command: string, cwd: string): BackgroundTerminalSession {
    const id = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: BackgroundTerminalSession = {
      id,
      command,
      cwd,
      startedAt: Date.now(),
      status: "running",
      output: "",
    };

    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const appendOutput = (chunk: string) => {
      session.output = `${session.output}${chunk}`;
      if (session.output.length > MAX_OUTPUT_CHARS) {
        session.output = session.output.slice(-MAX_OUTPUT_CHARS);
      }
    };

    child.stdout.on("data", (chunk) => appendOutput(chunk.toString()));
    child.stderr.on("data", (chunk) => appendOutput(chunk.toString()));

    child.on("error", (error) => {
      session.status = "failed";
      session.endedAt = Date.now();
      appendOutput(`\n[process error] ${error.message}\n`);
      this.processes.delete(id);
    });

    child.on("close", (code, signal) => {
      session.status = code === 0 ? "exited" : "failed";
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = Date.now();
      this.processes.delete(id);
    });

    this.sessions.set(id, session);
    this.processes.set(id, child);
    return session;
  }

  list(): BackgroundTerminalSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  stop(id: string): boolean {
    const child = this.processes.get(id);
    if (!child) {
      return false;
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 3000).unref();
    return true;
  }

  get(id: string): BackgroundTerminalSession | null {
    return this.sessions.get(id) ?? null;
  }
}

export const backgroundTerminals = new BackgroundTerminalManager();
