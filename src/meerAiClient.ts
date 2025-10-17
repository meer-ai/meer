import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface CommandParts {
  executable: string;
  args: string[];
}

export interface AskOptions {
  cwd?: string;
  token?: vscode.CancellationToken;
  onData?: (chunk: string) => void;
}

export class MeerAiClient {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  public async ask(question: string, options: AskOptions = {}): Promise<string> {
    const configuration = vscode.workspace.getConfiguration('meerai');
    const commandLine = configuration.get<string>('cliCommand', 'meer').trim();
    const maxBufferKb = configuration.get<number>('maxBuffer', 1024);
    const maxBufferBytes = Math.max(128, maxBufferKb) * 1024;

    const { executable, args } = this.parseCommand(commandLine);
    const spawnArgs = [...args, 'ask', question];

    const workingDirectory = options.cwd ?? this.resolveWorkspaceRoot();
    if (!workingDirectory) {
      throw new Error('MeerAI requires an open workspace folder.');
    }

    const env = {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };

    return new Promise<string>((resolve, reject) => {
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const child = spawn(executable, spawnArgs, {
        cwd: workingDirectory,
        env,
        shell: false,
      });

      const disposeCancellation = options.token?.onCancellationRequested(() => {
        if (!child.killed) {
          child.kill();
        }
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        stdoutBuffer = this.appendWithLimit(stdoutBuffer, data, maxBufferBytes);
        options.onData?.(data);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => {
        stderrBuffer = this.appendWithLimit(stderrBuffer, data, maxBufferBytes);
        this.outputChannel.append(data);
      });

      child.on('error', (error) => {
        disposeCancellation?.dispose();
        reject(this.normalizeError(error, executable, workingDirectory));
      });

      child.on('close', (code) => {
        disposeCancellation?.dispose();

        if (code === 0) {
          resolve(stdoutBuffer.trim());
        } else if (options.token?.isCancellationRequested) {
          reject(new Error('Request cancelled.'));
        } else {
          const message = stderrBuffer.trim() || `MeerAI CLI exited with code ${code}.`;
          reject(new Error(message));
        }
      });
    });
  }

  private resolveWorkspaceRoot(): string | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    const [firstFolder] = vscode.workspace.workspaceFolders ?? [];
    return firstFolder?.uri.fsPath;
  }

  private parseCommand(commandLine: string): CommandParts {
    if (!commandLine) {
      throw new Error('MeerAI CLI command is empty.');
    }

    const segments = commandLine.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((segment) => {
      const trimmed = segment.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
      }
      return trimmed;
    });

    if (!segments || segments.length === 0) {
      throw new Error(`Unable to parse MeerAI CLI command: "${commandLine}"`);
    }

    let executable = segments[0];

    if (process.platform === 'win32' && !this.hasExecutableExtension(executable)) {
      const candidate = `${executable}.cmd`;
      if (this.commandExists(candidate)) {
        executable = candidate;
      }
    }

    return {
      executable,
      args: segments.slice(1),
    };
  }

  private appendWithLimit(current: string, incoming: string, limitBytes: number): string {
    if (!incoming) {
      return current;
    }

    const combined = current + incoming;
    const asBuffer = Buffer.from(combined, 'utf8');
    if (asBuffer.byteLength <= limitBytes) {
      return combined;
    }

    const truncated = asBuffer.subarray(Math.max(0, asBuffer.byteLength - limitBytes));
    return truncated.toString('utf8');
  }

  private hasExecutableExtension(command: string): boolean {
    return ['.cmd', '.exe', '.bat', '.com'].some((ext) => command.toLowerCase().endsWith(ext));
  }

  private commandExists(candidate: string): boolean {
    if (path.isAbsolute(candidate)) {
      return fs.existsSync(candidate);
    }

    const pathEntries = process.env.PATH?.split(path.delimiter) ?? [];
    for (const entry of pathEntries) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) {
        return true;
      }
    }
    return false;
  }

  private normalizeError(error: Error & { code?: string }, executable: string, cwd: string): Error {
    if (error.code === 'ENOENT') {
      return new Error(
        `MeerAI CLI command not found: "${executable}". Update the "meerai.cliCommand" setting or ensure the MeerAI CLI is installed. (cwd: ${cwd})`
      );
    }
    return error;
  }
}
