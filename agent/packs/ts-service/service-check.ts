import { join } from "node:path";
import { Node, SyntaxKind, type SourceFile, type TypeAliasDeclaration, type VariableDeclaration } from "ts-morph";
import type { DeliverCheckResult } from "../ts/pack.ts";
import { deliveryProject, reachableFrom } from "../ts/scripts/delivery-graph.ts";

function routerImplementation(alias: TypeAliasDeclaration): VariableDeclaration | undefined {
  const query = alias.getTypeNode();
  if (!query || !Node.isTypeQuery(query)) return undefined;
  const name = query.getExprName();
  const symbol = name.getSymbol();
  const declarations = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
  return declarations.find((declaration): declaration is VariableDeclaration =>
    Node.isVariableDeclaration(declaration) && declaration.isExported() &&
    !declaration.getSourceFile().getFilePath().endsWith(".contract.ts") &&
    declaration.getInitializer() !== undefined);
}

function resolvesAlias(file: SourceFile, name: string, aliases: readonly TypeAliasDeclaration[]): boolean {
  const declaration = file.getImportDeclarations().flatMap((item) => item.getNamedImports())
    .find((item) => (item.getAliasNode()?.getText() ?? item.getName()) === name);
  if (!declaration) return false;
  const symbol = (declaration.getAliasNode() ?? declaration.getNameNode()).getSymbol();
  const declarations = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
  return aliases.some((alias) => declarations.includes(alias));
}

export function runServiceCheck(cwd: string, packs: readonly string[]): DeliverCheckResult {
  const block = (summary: string): DeliverCheckResult => ({ verdict: "block", summary: `ts-service: ${summary}` });
  const project = deliveryProject(cwd);
  const aliases = project.getSourceFiles().filter((file) => file.getFilePath().endsWith(".contract.ts"))
    .flatMap((file) => file.getTypeAliases())
    .filter((alias) => alias.getName() === "ServiceRouter" && alias.isExported() && routerImplementation(alias));
  if (aliases.length === 0) return block("a service contract must export ServiceRouter = typeof an exported, implemented router");
  // The existing purity gates reject erased router aliases. Require an actual
  // inferred router construction too: `typeof` an arbitrary stub is not a service.
  for (const alias of aliases) {
    const router = routerImplementation(alias)!;
    const initializer = router.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) return block("ServiceRouter must describe a constructed router, not a placeholder");
    const expression = initializer.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== "router") {
      return block("the exported router must be inferred from the service runtime's router(...) constructor");
    }
  }
  if (!packs.includes("ts-web")) return { verdict: "pass", summary: "ts-service: implemented ServiceRouter exported; no UI client required" };
  const client = project.getSourceFile(join(cwd, "src/ui/shared/api/client.tsx")) ??
    project.getSourceFile(join(cwd, "src/ui/shared/api/client.ts"));
  if (!client) return block("UI + service requires src/ui/shared/api/client.tsx typed against this service's ServiceRouter");
  const factoryNames = client.getImportDeclarations().filter((item) => item.getModuleSpecifierValue() === "@trpc/client")
    .flatMap((item) => item.getNamedImports()).filter((item) => item.getName() === "createTRPCClient")
    .map((item) => item.getAliasNode()?.getText() ?? item.getName());
  const calls = client.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => factoryNames.includes(call.getExpression().getText()));
  if (calls.length !== 1 || calls[0]!.getTypeArguments().length !== 1 ||
      !resolvesAlias(client, calls[0]!.getTypeArguments()[0]!.getText(), aliases)) {
    return block("the single network door must call createTRPCClient<ServiceRouter> using this project's service contract type");
  }
  const main = project.getSourceFile(join(cwd, "src/ui/main.tsx"));
  if (!main || !reachableFrom(main).includes(client)) return block("the browser entry must reach the typed network door through runtime imports");
  return { verdict: "pass", summary: "ts-service + ts-web: reachable network door uses this service's inferred ServiceRouter" };
}
