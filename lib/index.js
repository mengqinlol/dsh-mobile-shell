/**
 * dsh-mobile-shell - mobile shell layer for the DSH Web GUI.
 *
 * The browser reaches this GUI over plain HTTP on a public IPv6 address, which
 * is NOT a secure context, so `crypto.randomUUID` does not exist and every DSH
 * RPC would fail. This plugin registers an index tap on the webserver and
 * injects three things into every served index.html:
 *
 *   1. a crypto.randomUUID polyfill (UUID v4 from crypto.getRandomValues);
 *   2. assets/mobile-fix.css - the mobile stylesheet (drawer overlay, page
 *      lock, dialog layout, 16px fields, no horizontal pan);
 *   3. assets/shell.js - the mobile behaviour (drawer scrim, tap-outside close,
 *      auto-close on conversation switch, no autofocus, keyboard inset).
 *
 * Both assets are read from disk on EVERY index request, so editing them takes
 * effect on a page refresh - no service restart (a loaded ESM module is cached
 * for the life of the process; only changes to this file need a restart).
 */
import { readFileSync } from "node:fs";
import { internals as workspaceFileInternals, registerWorkspaceFiles } from "./workspace-files.js";

const name = "dsh-mobile-shell";

/**
 * webServer: the index tap that injects the polyfill + stylesheet + script.
 * connection + workspaceRegistry: the workspace file browser routes, which ride
 * Connection's authentication (the same session cookie the GUI uses).
 */
const inject = ["webServer", "connection", "workspaceRegistry"];

/** Standard UUID v4 from crypto.getRandomValues (available in insecure contexts). */
function uuidV4Fallback() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
	const hex = Array.prototype.map.call(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const POLYFILL_SCRIPT = `<script>
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
	crypto.randomUUID = ${uuidV4Fallback.toString()};
}
</script>`;

const ASSET_DIR = new URL("../assets/", import.meta.url);

/**
 * Read one asset file, or "" when it is missing.
 * @param file - file name inside ../assets/.
 */
function readAsset(file) {
	try {
		return readFileSync(new URL(file, ASSET_DIR), "utf8").trim();
	} catch {
		return "";
	}
}

/** Build the injected head markup from the current on-disk assets. */
function renderHead() {
	const css = readAsset("mobile-fix.css");
	const shell = readAsset("shell.js");
	return (
		POLYFILL_SCRIPT +
		(css === "" ? "" : `<style>\n${css}\n</style>`) +
		(shell === "" ? "" : `<script>\n${shell}\n</script>`)
	);
}

/**
 * @param ctx - plugin context (`inject: [webServer, connection, workspaceRegistry]`).
 */
function apply(ctx) {
	ctx.webServer.tapIndex((html) => {
		// Guard: the polyfill is the idempotence marker.
		if (html.includes("randomUUID")) return html;
		return html.replace("</head>", renderHead() + "</head>");
	});

	const missing = ["mobile-fix.css", "shell.js"].filter((file) => readAsset(file) === "");
	if (missing.length > 0) {
		const message = `dsh-mobile-shell: assets not readable (${missing.join(", ")}) next to ${ASSET_DIR.pathname}; only the polyfill is being injected`;
		if (typeof ctx.logger === "function") ctx.logger("dsh-mobile-shell").warn(message);
		else console.warn(message);
	}

	// Workspace file browser: /api/workspace-files (.download / .open) - the
	// routes ride the same cookie authentication as the GUI itself.
	registerWorkspaceFiles(ctx);
}

export { apply, inject, name };

/** Exposed for the smoke test (workspace-file route internals). */
export const workspaceFiles = { internals: workspaceFileInternals };
