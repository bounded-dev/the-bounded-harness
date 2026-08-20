/**
 * Zentty terminal integration — guarded loader.
 *
 * The Zentty app ships a pi extension inside its macOS app bundle. Loading it
 * via an absolute path in settings.json would make the committed global config
 * machine-specific (ADR 2026-007), so it lives here instead: present on
 * machines with Zentty installed, a silent no-op everywhere else.
 *
 * If Zentty integration misbehaves when loaded this way, fall back to a
 * per-machine (uncommitted) entry in settings.json's `extensions` list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ZENTTY_EXTENSION = "/Applications/Zentty.app/Contents/Resources/pi/extensions/zentty-pi-zentty.js";

export default async function (pi: ExtensionAPI) {
	if (!existsSync(ZENTTY_EXTENSION)) return;
	const mod: unknown = await import(pathToFileURL(ZENTTY_EXTENSION).href);
	const init = (mod as { default?: unknown }).default;
	if (typeof init === "function") await (init as (pi: ExtensionAPI) => unknown)(pi);
}
