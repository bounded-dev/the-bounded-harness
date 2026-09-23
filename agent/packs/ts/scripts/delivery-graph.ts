// Compiler-parsed import graph for delivery obligations. Comments never form edges.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Node, Project, SyntaxKind, type SourceFile } from "ts-morph";

export function deliveryProject(cwd: string): Project {
  const config = join(cwd, "tsconfig.json");
  const project = existsSync(config)
    ? new Project({ tsConfigFilePath: config, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { allowJs: true } });
  project.addSourceFilesAtPaths(join(cwd, "src/**/*.{ts,tsx,js,jsx}"));
  project.resolveSourceFileDependencies();
  return project;
}

/** Runtime imports/re-exports and literal dynamic imports; type-only edges do
 * not prove that a page or network door can be reached by the running app. */
export function runtimeDependencies(file: SourceFile): readonly SourceFile[] {
  const result: SourceFile[] = [];
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    const bindings = declaration.getNamedImports();
    if (bindings.length > 0 && bindings.every((binding) => binding.isTypeOnly()) &&
        !declaration.getDefaultImport() && !declaration.getNamespaceImport()) continue;
    const target = declaration.getModuleSpecifierSourceFile();
    if (target) result.push(target);
  }
  for (const declaration of file.getExportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    const target = declaration.getModuleSpecifierSourceFile();
    if (target) result.push(target);
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const argument = call.getArguments()[0];
    if (!argument || !Node.isStringLiteral(argument)) continue;
    const symbol = argument.getSymbol();
    for (const declaration of symbol?.getDeclarations() ?? []) {
      if (Node.isSourceFile(declaration)) result.push(declaration);
    }
  }
  return result;
}

export function reachableFrom(start: SourceFile): readonly SourceFile[] {
  const visited = new Map<string, SourceFile>();
  const pending = [start];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file.getFilePath())) continue;
    visited.set(file.getFilePath(), file);
    for (const next of runtimeDependencies(file)) {
      if (!next.getFilePath().includes("/node_modules/")) pending.push(next);
    }
  }
  return [...visited.values()];
}
