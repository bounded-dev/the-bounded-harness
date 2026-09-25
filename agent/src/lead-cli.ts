// Narrow project-local run control for hosts that reach tools through a shell.
// The host hook validates the exact command before it reaches this process.
import { prepareLeadRun } from "./lead-policy.ts";

const [action, option, ...rest] = process.argv.slice(2);
const fresh = option === "--new";
const ticket = fresh ? rest[0] : option;
if (action !== "prepare" || rest.length > (fresh ? 1 : 0)) {
  process.stderr.write("usage: bounded lead prepare [--new] [ticket-number]\n");
  process.exitCode = 2;
} else {
  const result = prepareLeadRun(process.cwd(), ticket, fresh);
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${result.ok ? result.summary : result.reason}\n`);
  if (!result.ok) process.exitCode = 1;
}
