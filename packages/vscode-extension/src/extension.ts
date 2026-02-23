import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const THINKWELL_SHEBANG = /^#!.*\bthinkwell\b/;

let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const active = await isThinkwellProject();
  if (!active) {
    return;
  }

  // The TS plugin is auto-loaded via contributes.typescriptServerPlugins in
  // package.json — no manual pluginPaths injection needed.

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = "$(beaker) Thinkwell";
  statusBarItem.tooltip = "Thinkwell TypeScript plugin is active";
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();
}

export function deactivate(): void {
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

/**
 * Detect whether the current workspace is a thinkwell project by checking:
 * 1. `thinkwell` in any workspace package.json dependencies
 * 2. Any open file with a `#!/usr/bin/env thinkwell` shebang
 */
async function isThinkwellProject(): Promise<boolean> {
  // Check package.json files in workspace folders
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const pkgPath = path.join(folder.uri.fsPath, "package.json");
      if (await hasThinkwellDep(pkgPath)) {
        return true;
      }
    }
  }

  // Check open editors for thinkwell shebangs
  for (const editor of vscode.window.visibleTextEditors) {
    const doc = editor.document;
    if (doc.lineCount > 0) {
      const firstLine = doc.lineAt(0).text;
      if (THINKWELL_SHEBANG.test(firstLine)) {
        return true;
      }
    }
  }

  // Scan workspace for shebang files
  if (folders) {
    const tsFiles = await vscode.workspace.findFiles("**/*.ts", "**/node_modules/**", 50);
    for (const uri of tsFiles) {
      if (await fileHasShebang(uri)) {
        return true;
      }
    }
  }

  return false;
}

async function hasThinkwellDep(pkgPath: string): Promise<boolean> {
  try {
    const content = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    return "thinkwell" in allDeps;
  } catch {
    return false;
  }
}

async function fileHasShebang(uri: vscode.Uri): Promise<boolean> {
  try {
    const buf = Buffer.alloc(64);
    const fd = fs.openSync(uri.fsPath, "r");
    try {
      fs.readSync(fd, buf, 0, 64, 0);
    } finally {
      fs.closeSync(fd);
    }
    const firstLine = buf.toString("utf-8").split("\n")[0];
    return THINKWELL_SHEBANG.test(firstLine);
  } catch {
    return false;
  }
}
