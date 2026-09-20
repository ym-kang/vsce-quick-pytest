import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { findTestTargets } from "./testTarget";

const providerSelector: vscode.DocumentSelector = { language: "python", scheme: "file" };
const lastRunConfigurationKey = "pytestQuickRun.lastRunConfiguration";

interface RunOptions {
  pytestArgs: string[];
  environmentVariables: Record<string, string>;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PytestCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(providerSelector, provider),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === "python") {
        provider.refresh();
      }
    }),
    provider,
    vscode.commands.registerCommand("pytestQuickRun.runAtCursor", (uri?: vscode.Uri, line?: number) => {
      return runAtCursor(context, uri, line, false);
    }),
    vscode.commands.registerCommand("pytestQuickRun.debugAtCursor", (uri?: vscode.Uri, line?: number) => {
      return runAtCursor(context, uri, line, true);
    })
  );
}

class PytestCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return findTestTargets(document.getText(), document.fileName).flatMap((target) => {
      const position = new vscode.Position(target.startLine, 0);
      return [
        new vscode.CodeLens(new vscode.Range(position, position), {
          command: "pytestQuickRun.runAtCursor",
          title: `▶ ${target.label}`,
          arguments: [document.uri, target.startLine]
        }),
        new vscode.CodeLens(new vscode.Range(position, position), {
          command: "pytestQuickRun.debugAtCursor",
          title: `🐞 Debug ${target.label.replace(/^Run /, "")}`,
          arguments: [document.uri, target.startLine]
        })
      ];
    });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

async function runAtCursor(
  context: vscode.ExtensionContext,
  uri: vscode.Uri | undefined,
  line: number | undefined,
  debug: boolean
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
  if (!document || document.languageId !== "python") {
    void vscode.window.showErrorMessage("Pytest Quick Run: open a Python test file first.");
    return;
  }

  const targetLine = line ?? editor?.selection.active.line ?? 0;
  const target = findTestTargets(document.getText(), document.fileName).find(
    (candidate) => candidate.startLine === targetLine
  );
  if (!target) {
    void vscode.window.showWarningMessage("Pytest Quick Run: no test function was found at this line.");
    return;
  }

  await document.save();

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const root = workspaceFolder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
  const config = vscode.workspace.getConfiguration("pytestQuickRun", document.uri);
  const pythonPath = resolvePythonPath(config, document.uri);
  const configuredCwd = config.get<string>("cwd", "").trim();
  const cwd = configuredCwd ? resolveWorkspacePath(configuredCwd, root) : root;
  const options = await promptRunOptions(context, config, debug);
  if (!options) {
    return;
  }

  const { pytestArgs: args, environmentVariables } = options;
  const relativeFile = path.relative(cwd, document.uri.fsPath).split(path.sep).join(path.posix.sep);
  const nodeId = `${relativeFile}::${target.nodeId.split("::").slice(1).join("::")}`;

  if (debug) {
    await debugTest(workspaceFolder, pythonPath, cwd, args, environmentVariables, nodeId, target.label);
    return;
  }

  const terminal = getTerminal(cwd, environmentVariables);
  terminal.show(true);
  terminal.sendText([quoteShell(pythonPath), "-m", "pytest", ...args.map(quoteShell), quoteShell(nodeId)].join(" "));
}

let activeRunOptionsPanel: vscode.WebviewPanel | undefined;

async function promptRunOptions(
  context: vscode.ExtensionContext,
  config: vscode.WorkspaceConfiguration,
  debug: boolean
): Promise<RunOptions | undefined> {
  const lastConfiguration = context.workspaceState.get<RunOptions>(lastRunConfigurationKey);
  const configuredArgs = lastConfiguration?.pytestArgs
    ?? config.get<string[]>("pytestArgs", ["-s"]);
  const configuredEnvironment = lastConfiguration?.environmentVariables
    ?? config.get<Record<string, string>>("environmentVariables", {});

  activeRunOptionsPanel?.dispose();
  const panel = vscode.window.createWebviewPanel(
    "pytestQuickRunConfiguration",
    debug ? "Pytest Quick Run · Debug Configuration" : "Pytest Quick Run · Run Configuration",
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: false }
  );
  activeRunOptionsPanel = panel;
  panel.webview.html = getRunOptionsHtml(
    panel.webview,
    debug,
    configuredArgs.map(quoteCommandLineArg).join(" "),
    Object.entries(configuredEnvironment).map(([key, value]) => `${key}=${value}`).join("; ")
  );

  return new Promise<RunOptions | undefined>((resolve) => {
    let completed = false;
    const complete = (options: RunOptions | undefined): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (activeRunOptionsPanel === panel) {
        activeRunOptionsPanel = undefined;
      }
      if (options) {
        void context.workspaceState.update(lastRunConfigurationKey, options);
      }
      panel.dispose();
      resolve(options);
    };

    panel.webview.onDidReceiveMessage((message: { type?: string; args?: unknown; environment?: unknown }) => {
      if (message.type === "cancel") {
        complete(undefined);
        return;
      }
      if (message.type !== "submit" || typeof message.args !== "string" || typeof message.environment !== "string") {
        return;
      }

      try {
        complete({
          pytestArgs: parseCommandLine(message.args),
          environmentVariables: parseEnvironmentVariables(message.environment)
        });
      } catch (error) {
        void panel.webview.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : "Invalid run configuration."
        });
      }
    });
    panel.onDidDispose(() => {
      if (!completed) {
        completed = true;
        if (activeRunOptionsPanel === panel) {
          activeRunOptionsPanel = undefined;
        }
        resolve(undefined);
      }
    });
  });
}

function getRunOptionsHtml(
  webview: vscode.Webview,
  debug: boolean,
  args: string,
  environmentVariables: string
): string {
  const nonce = randomBytes(16).toString("hex");
  const title = debug ? "Debug pytest test" : "Run pytest test";
  const action = debug ? "Start Debugging" : "Run Test";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body { padding: 32px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
    .intro { color: var(--vscode-descriptionForeground); margin: 0 0 28px; }
    label { display: block; font-weight: 600; margin: 18px 0 8px; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 8px; }
    input, textarea { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 10px 12px; font: inherit; border-radius: 4px; }
    textarea { min-height: 120px; resize: vertical; font-family: var(--vscode-editor-font-family); }
    input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .error { min-height: 20px; color: var(--vscode-errorForeground); margin-top: 12px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
    button { border: 0; border-radius: 4px; padding: 8px 16px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p class="intro">Configure this run. Your last configuration is restored automatically for this workspace.</p>
    <form id="configuration-form">
      <label for="pytest-args">Additional pytest arguments</label>
      <p class="hint">Example: -s --maxfail=1 --tb=short</p>
      <input id="pytest-args" type="text" value="${escapeHtml(args)}" autocomplete="off" spellcheck="false">

      <label for="environment">Environment variables</label>
      <p class="hint">Use KEY=VALUE separated by semicolons or one per line.</p>
      <textarea id="environment" spellcheck="false">${escapeHtml(environmentVariables)}</textarea>
      <div id="error" class="error" role="alert"></div>

      <div class="actions">
        <button id="cancel" class="secondary" type="button">Cancel</button>
        <button type="submit">${action}</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('configuration-form');
    const error = document.getElementById('error');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      error.textContent = '';
      vscode.postMessage({
        type: 'submit',
        args: document.getElementById('pytest-args').value,
        environment: document.getElementById('environment').value
      });
    });
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'error') {
        error.textContent = event.data.message;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }

  if (escaped) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Unclosed quote in pytest arguments.");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function parseEnvironmentVariables(value: string): Record<string, string> {
  const environmentVariables: Record<string, string> = {};
  if (!value.trim()) {
    return environmentVariables;
  }

  for (const entry of value.split(/[;\n]/)) {
    if (!entry.trim()) {
      continue;
    }
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator).trim();
    const variableValue = entry.slice(separator + 1).trim();
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Use KEY=VALUE format: ${entry.trim()}`);
    }
    environmentVariables[key] = variableValue;
  }
  return environmentVariables;
}

function quoteCommandLineArg(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/([\\"])/g, "\\$1")}"` : value;
}

async function debugTest(
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  pythonPath: string,
  cwd: string,
  args: string[],
  environmentVariables: Record<string, string>,
  nodeId: string,
  label: string
): Promise<void> {
  const started = await vscode.debug.startDebugging(workspaceFolder, {
    type: "debugpy",
    request: "launch",
    name: `Pytest Quick Run: ${label}`,
    python: pythonPath,
    module: "pytest",
    args: [...args, nodeId],
    cwd,
    env: environmentVariables,
    console: "integratedTerminal",
    justMyCode: false
  });

  if (!started) {
    void vscode.window.showErrorMessage(
      "Pytest Quick Run: debug session could not start. Install the Python and Python Debugger extensions."
    );
  }
}

function resolvePythonPath(
  config: vscode.WorkspaceConfiguration,
  documentUri: vscode.Uri
): string {
  const configuredPython = config.get<string>("pythonPath", "").trim();
  const pythonConfig = vscode.workspace.getConfiguration("python", documentUri);
  return configuredPython
    || pythonConfig.get<string>("defaultInterpreterPath", "").trim()
    || pythonConfig.get<string>("pythonPath", "").trim()
    || "python3";
}

let pytestTerminal: vscode.Terminal | undefined;
let pytestTerminalCwd: string | undefined;
let pytestTerminalEnvironmentKey: string | undefined;

function getTerminal(cwd: string, environmentVariables: Record<string, string>): vscode.Terminal {
  const environmentKey = JSON.stringify(environmentVariables, Object.keys(environmentVariables).sort());
  if (
    !pytestTerminal
    || pytestTerminal.exitStatus
    || pytestTerminalCwd !== cwd
    || pytestTerminalEnvironmentKey !== environmentKey
  ) {
    pytestTerminal?.dispose();
    pytestTerminal = vscode.window.createTerminal({
      name: "Pytest Quick Run",
      cwd,
      env: environmentVariables
    });
    pytestTerminalCwd = cwd;
    pytestTerminalEnvironmentKey = environmentKey;
  }
  return pytestTerminal;
}

function resolveWorkspacePath(value: string, workspaceRoot: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function deactivate(): void {
  pytestTerminal?.dispose();
  pytestTerminal = undefined;
  pytestTerminalCwd = undefined;
  pytestTerminalEnvironmentKey = undefined;
}
