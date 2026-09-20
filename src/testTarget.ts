export interface TestTarget {
  /** The pytest node id, e.g. test_math.py::test_add. */
  nodeId: string;
  /** The source range occupied by the declaration. */
  startLine: number;
  /** The test name shown in the CodeLens. */
  label: string;
}

interface Declaration {
  indent: number;
  name: string;
  line: number;
  kind: "class" | "function";
}

const declarationPattern = /^(?<indent>\s*)(?<async>async\s+)?(?<kind>def|class)\s+(?<name>[A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/;

/**
 * Finds pytest node ids without importing or executing the user's Python code.
 * This deliberately handles the common pytest shapes and keeps the extension
 * responsive even when a repository contains a large number of files.
 */
export function findTestTargets(text: string, fileName: string): TestTarget[] {
  if (!isPythonFile(fileName)) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const declarations: Declaration[] = [];
  const targets: TestTarget[] = [];

  for (let line = 0; line < lines.length; line += 1) {
    const match = declarationPattern.exec(lines[line]);
    if (!match?.groups) {
      continue;
    }

    const name = match.groups.name;
    const kind = match.groups.kind === "class" ? "class" : "function";
    const indent = match.groups.indent.length;

    while (declarations.length > 0 && declarations[declarations.length - 1].indent >= indent) {
      declarations.pop();
    }

    declarations.push({ indent, name, line, kind });

    if (kind === "function" && name.startsWith("test_")) {
      const parent = declarations.length > 1 ? declarations[declarations.length - 2] : undefined;
      const testClass = parent?.kind === "class" && parent.name.startsWith("Test") ? parent : undefined;
      if (parent && !testClass) {
        continue;
      }
      const nodeParts = [toRelativePath(fileName), testClass?.name, name]
        .filter((part): part is string => Boolean(part));
      targets.push({
        nodeId: nodeParts.join("::"),
        startLine: line,
        label: `Run ${testClass ? `${testClass.name}::` : ""}${name}`
      });
    }
  }

  return targets;
}

function isPythonFile(fileName: string): boolean {
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
  return baseName.endsWith(".py");
}

function toRelativePath(fileName: string): string {
  return fileName.replace(/\\/g, "/");
}
