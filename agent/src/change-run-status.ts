// A change run may rotate the guard log only after the previous delivery
// finished. Delivery records intermediate steps, so an arbitrary deliver/pass
// event is not evidence of completion.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DeliveryState = "delivered" | "undelivered" | "malformed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** File order is authoritative: a later failed delivery voids an earlier pass. */
export function deliveryState(raw: string): DeliveryState {
  let latestDeliver: Record<string, unknown> | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return "malformed";
    }
    if (
      !isRecord(event) ||
      typeof event["guard"] !== "string" ||
      !["pass", "block", "error"].includes(String(event["verdict"])) ||
      typeof event["summary"] !== "string"
    ) return "malformed";
    if (event["guard"] === "deliver") latestDeliver = event;
  }
  if (latestDeliver === undefined) return "undelivered";
  const detail = latestDeliver["detail"];
  return latestDeliver["verdict"] === "pass" && isRecord(detail) && detail["step"] === "summary"
    ? "delivered"
    : "undelivered";
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write("usage: node change-run-status.ts <guard-log.jsonl>\n");
    process.exitCode = 2;
  } else {
    try {
      const state = deliveryState(readFileSync(path, "utf8"));
      process.stdout.write(`${state}\n`);
    } catch (err) {
      process.stderr.write(`bounded change-run: cannot read guard log: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  }
}
