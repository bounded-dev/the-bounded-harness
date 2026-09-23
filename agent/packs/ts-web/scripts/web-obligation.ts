import { join } from "node:path";
import type { DeliverCheckResult } from "../../ts/pack.ts";
import { deliveryProject, reachableFrom } from "../../ts/scripts/delivery-graph.ts";
import { BOOTSTRAP_RELATIVE, runBuildCheck } from "./build-check.ts";

export function runWebObligation(cwd: string): DeliverCheckResult {
  const project = deliveryProject(cwd);
  const main = project.getSourceFile(join(cwd, BOOTSTRAP_RELATIVE));
  const block = (summary: string): DeliverCheckResult => ({ verdict: "block", summary: `ts-web: ${summary}` });
  if (!main) return block(`missing ${BOOTSTRAP_RELATIVE}; the composed UI must have a browser entry`);
  const bootstrap = runBuildCheck(cwd);
  if (bootstrap.verdict === "block") return bootstrap;
  const reachable = reachableFrom(main);
  const app = reachable.find((file) => /\/src\/ui\/app\.tsx?$/.test(file.getFilePath()));
  if (!app) return block("the browser entry must reach src/ui/app.tsx");
  const pages = reachableFrom(app).filter((file) => /\/src\/ui\/(pages|features)\//.test(file.getFilePath()));
  const domainRoot = join(cwd, "src") + "/";
  const connected = pages.some((page) => reachableFrom(page).some((file) => {
    const path = file.getFilePath();
    if (!path.startsWith(domainRoot) || path.startsWith(join(cwd, "src/ui") + "/") || path.endsWith(".contract.ts")) return false;
    const contract = path.replace(/\.(tsx?|jsx?)$/, ".contract.ts");
    return project.getSourceFile(contract) !== undefined;
  }));
  if (!connected) return block("a reachable page or feature must import a domain implementation with a contract");
  return { verdict: "pass", summary: "ts-web: browser entry reaches app, page/feature and a domain contract's implementation" };
}
