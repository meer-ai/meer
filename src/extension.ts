import * as vscode from 'vscode';
import { MeerAiChatViewProvider } from './chatViewProvider';
import { MeerAiClient } from './meerAiClient';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('MeerAI');
  context.subscriptions.push(outputChannel);

  const client = new MeerAiClient(outputChannel);
  const chatProvider = new MeerAiChatViewProvider(context, client);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MeerAiChatViewProvider.viewType,
      chatProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('meerai.askWorkspace', async () => {
      const question = await vscode.window.showInputBox({
        prompt: 'Ask MeerAI about your workspace',
        placeHolder: 'How is this function used?',
      });

      if (!question) {
        return;
      }

      const folder = resolveWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage('MeerAI: open a workspace folder to ask questions.');
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            title: 'MeerAI is thinking…',
            location: vscode.ProgressLocation.Notification,
            cancellable: true,
          },
          async (_progress, token) => {
            outputChannel.appendLine(`\n> ${question}`);
            await client.ask(question, {
              cwd: folder.uri.fsPath,
              token,
              onData: (chunk) => outputChannel.append(chunk),
            });
            outputChannel.appendLine('');
          }
        );
        outputChannel.show(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`MeerAI: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('meerai.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('MeerAI: open a file and select the code to explain.');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection).trim();
      if (!selectedText) {
        vscode.window.showInformationMessage('MeerAI: highlight some code to explain.');
        return;
      }

      const folder =
        vscode.workspace.getWorkspaceFolder(editor.document.uri) ?? resolveWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage('MeerAI: open a workspace folder to ask questions.');
        return;
      }

      const prompt = `Explain the following code snippet:\n\n${selectedText}`;

      try {
        await vscode.window.withProgress(
          {
            title: 'MeerAI is explaining…',
            location: vscode.ProgressLocation.Window,
            cancellable: true,
          },
          async (_progress, token) => {
            outputChannel.appendLine(`\n> ${prompt}`);
            await client.ask(prompt, {
              cwd: folder.uri.fsPath,
              token,
              onData: (chunk) => outputChannel.append(chunk),
            });
            outputChannel.appendLine('');
          }
        );
        outputChannel.show(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`MeerAI: ${message}`);
      }
    })
  );
}

export function deactivate() {
  // No-op
}

function resolveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder;
    }
  }
  const [first] = vscode.workspace.workspaceFolders ?? [];
  return first;
}
