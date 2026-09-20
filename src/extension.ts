import * as path from "node:path";
import * as vscode from "vscode";
import { findTestTargets } from "./testTarget";

const providerSelector: vscode.DocumentSelector = { language: "python", scheme: "file" };

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
      return runAtCursor(uri, line, false);
    }),
    vscode.commands.registerCommand("pytestQuickRun.debugAtCursor", (uri?: vscode.Uri, line?: number) => {
      return runAtCursor(uri, line, true);
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

async function runAtCursor(uri: vscode.Uri | undefined, line: number | undefined, debug: boolean): Promise<void> {
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
  const args = config.get<string[]>("pytestArgs", ["-s"]);
  const relativeFile = path.relative(cwd, document.uri.fsPath).split(path.sep).join(path.posix.sep);
  const nodeId = `${relativeFile}::${target.nodeId.split("::").slice(1).join("::")}`;

  if (debug) {
    await debugTest(workspaceFolder, pythonPath, cwd, args, nodeId, target.label);
    return;
  }

  const terminal = getTerminal(cwd);
  terminal.show(true);
  terminal.sendText([quoteShell(pythonPath), "-m", "pytest", ...args.map(quoteShell), quoteShell(nodeId)].join(" "));
}

async function debugTest(
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  pythonPath: string,
  cwd: string,
  args: string[],
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

function getTerminal(cwd: string): vscode.Terminal {
  if (!pytestTerminal || pytestTerminal.exitStatus || pytestTerminalCwd !== cwd) {
    pytestTerminal?.dispose();
    pytestTerminal = vscode.window.createTerminal({ name: "Pytest Quick Run", cwd });
    pytestTerminalCwd = cwd;
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
}
