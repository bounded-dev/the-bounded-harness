// Resolve the design owned by the active ticket. The TN is the durable prose;
// the contract paths in its front matter are the precise freeze surface.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface TicketDesign {
  readonly ticket: string;
  readonly note: string;
  readonly status: "draft" | "active" | "ratified" | "superseded";
  readonly contracts: readonly string[];
}

export interface TicketWriteScope {
  readonly ticket?: string;
  readonly contracts: readonly string[];
  readonly error?: string;
}

const TICKET = /^[1-9][0-9]*$/;
const CONTRACT = /^src\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.contract\.ts$/;

function safeContract(root: string, path: string): void {
  if (!CONTRACT.test(path) || path.split("/").includes("..")) {
    throw new Error(`unsafe contract path '${path}' in ticket TN`);
  }
  const absolute = join(root, path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`ticket TN names missing contract '${path}'`);
  }
  const rel = relative(realpathSync(root), realpathSync(absolute)).split(sep).join("/");
  if (rel !== path) throw new Error(`contract '${path}' escapes the project or uses a symlink`);
}

function parseNote(root: string, ticket: string, checkFiles = true, requireContracts = true): TicketDesign {
  const note = `docs/tn/TN-${ticket}.md`;
  const absolute = join(root, note);
  if (!existsSync(absolute)) throw new Error(`ticket #${ticket} needs ${note} before design review or freeze`);
  const body = readFileSync(absolute, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!match) throw new Error(`${note} needs TN front matter`);
  const lines = match[1]!.split(/\r?\n/);
  const issue = lines.find((line) => line.startsWith("issue:"))?.slice(6).trim();
  if (issue !== ticket) throw new Error(`${note} must declare issue: ${ticket}`);
  const status = lines.find((line) => line.startsWith("status:"))?.slice(7).trim();
  if (!status || !["draft", "active", "ratified", "superseded"].includes(status)) {
    throw new Error(`${note} needs a valid status`);
  }
  if (status === "superseded" && checkFiles) throw new Error(`${note} is superseded and cannot be frozen`);
  if (status === "superseded") {
    const successors = [...body.matchAll(/\]\(TN-([1-9][0-9]*)\.md\)/g)].map((match) => match[1]!);
    if (!successors.length || successors.some((next) => next === ticket ||
      !existsSync(join(root, `docs/tn/TN-${next}.md`)))) {
      throw new Error(`${note} must link to an existing successor TN`);
    }
  }
  const start = lines.findIndex((line) => line === "contracts:");
  if (start < 0 && requireContracts) throw new Error(`${note} needs a contracts: list`);
  const contracts: string[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break;
    const item = /^  - (.+)$/.exec(line);
    if (!item) throw new Error(`${note} has an invalid contracts: list`);
    contracts.push(item[1]!.trim());
  }
  if ((requireContracts && !contracts.length) || new Set(contracts).size !== contracts.length) {
    throw new Error(`${note} needs distinct owned contracts`);
  }
  for (const path of contracts) {
    if (!CONTRACT.test(path) || path.split("/").includes("..")) {
      throw new Error(`unsafe contract path '${path}' in ticket TN`);
    }
    if (checkFiles) safeContract(root, path);
  }
  return { ticket, note, status: status as TicketDesign["status"], contracts: contracts.sort() };
}

/** Undefined only for projects created before ticket-numbered TNs. */
export function activeTicketDesign(root: string): TicketDesign | undefined {
  if (!existsSync(join(root, "docs/tn/README.md"))) return undefined;
  const ticket = process.env.BOUNDED_TICKET;
  if (!ticket || !TICKET.test(ticket)) {
    throw new Error("set BOUNDED_TICKET to the current issue number before using design gates");
  }
  const active = parseNote(root, ticket);
  for (const entry of readdirSync(join(root, "docs/tn"))) {
    const other = /^TN-([1-9][0-9]*)\.md$/.exec(entry)?.[1];
    if (!other || other === ticket) continue;
    const owned = parseNote(root, other, false, false);
    if (owned.status === "superseded") continue;
    const overlap = active.contracts.filter((path) => owned.contracts.includes(path));
    if (overlap.length) throw new Error(`${active.note} and ${owned.note} both own ${overlap.join(", ")}`);
  }
  return active;
}

/** Resolve ownership for path writes, including a not-yet-created contract. */
export function ticketWriteScope(root: string): TicketWriteScope | undefined {
  if (!existsSync(join(root, "docs/tn/README.md"))) return undefined;
  const ticket = process.env.BOUNDED_TICKET;
  if (!ticket || !TICKET.test(ticket)) {
    return { contracts: [], error: "set BOUNDED_TICKET to the current issue number" };
  }
  if (!existsSync(join(root, `docs/tn/TN-${ticket}.md`))) return { ticket, contracts: [] };
  try {
    const active = parseNote(root, ticket, false, false);
    for (const entry of readdirSync(join(root, "docs/tn"))) {
      const other = /^TN-([1-9][0-9]*)\.md$/.exec(entry)?.[1];
      if (!other || other === ticket) continue;
      const note = parseNote(root, other, false, false);
      if (note.status === "superseded") continue;
      const overlap = active.contracts.filter((path) => note.contracts.includes(path));
      if (overlap.length) throw new Error(`${active.note} and ${note.note} both own ${overlap.join(", ")}`);
    }
    return { ticket, contracts: active.contracts };
  } catch (error) {
    return { ticket, contracts: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function designNotePath(root: string): string {
  return activeTicketDesign(root)?.note ?? "spec.md";
}
