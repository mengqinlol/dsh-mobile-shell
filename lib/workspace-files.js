/**
 * Workspace file browser for dsh-mobile-shell.
 *
 * Three exact routes on the Connection transport. They inherit its
 * authentication and browser-trust fence, so only an authenticated owner Peer -
 * a browser holding the session cookie - can reach them:
 *
 *   GET  /api/workspace-files            directory browser (self-contained HTML)
 *   GET  /api/workspace-files.download   file bytes as an attachment
 *   POST /api/workspace-files.open       reveal the folder in the host's file
 *                                        manager (Explorer / Finder / xdg-open)
 *
 * Roots come from the workspace registry, so the page shows exactly the
 * workspaces the GUI knows about. Every request is resolved with realpath and
 * refused unless it stays inside its workspace (`..` and symlink escapes).
 */
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { collectFiles, zipFiles } from "./zip.js";

const PAGE_PATH = "/api/workspace-files";
const DOWNLOAD_PATH = "/api/workspace-files.download";
const OPEN_PATH = "/api/workspace-files.open";
const ZIP_PATH = "/api/workspace-files.zip";

/** Guard rail: one directory listing is not an unbounded response. */
const MAX_ENTRIES = 2000;

const CONTENT_TYPES = new Map([
	[".txt", "text/plain; charset=utf-8"],
	[".md", "text/plain; charset=utf-8"],
	[".json", "application/json"],
	[".js", "text/javascript; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".svg", "image/svg+xml"],
	[".pdf", "application/pdf"],
	[".zip", "application/zip"],
	[".mp4", "video/mp4"],
	[".mp3", "audio/mpeg"],
]);

function contentTypesForPath(path) {
	return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/gu, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${String(bytes)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(ms) {
	const date = new Date(ms);
	const pad = (value) => String(value).padStart(2, "0");
	return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Windows paths compare case-insensitively; every platform must stay inside root. */
function isWithin(root, target) {
	const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
	const rootWithSep = normalize(root.endsWith(sep) ? root : root + sep);
	return normalize(target) === normalize(root) || normalize(target).startsWith(rootWithSep);
}

/** Workspace roots, or the process directory when the registry is empty. */
function workspaceRoots(ctx) {
	const records = ctx.workspaceRegistry.list() ?? [];
	const roots = records.map((record) => ({
		title: record.title === "" ? basename(record.path) : record.title,
		path: record.path,
	}));
	if (roots.length === 0) roots.push({ title: basename(process.cwd()), path: process.cwd() });
	return roots;
}

function readParams(url) {
	const rawIndex = Number(url.searchParams.get("w") ?? "0");
	return {
		index: Number.isInteger(rawIndex) ? rawIndex : 0,
		relative: url.searchParams.get("p") ?? "",
	};
}

/**
 * Resolve a request path inside one workspace root.
 * @returns the real path plus the real workspace root it belongs to.
 * @throws when the workspace is unknown, the entry is missing, or the path
 *   escapes the workspace (via `..`, a symlink, another drive, ...).
 */
async function resolveTarget(roots, index, relative) {
	if (index < 0 || index >= roots.length) throw new Error("unknown workspace");
	const root = roots[index].path;
	const realRoot = await realpath(root).catch(() => root);
	const candidate = resolve(realRoot, relative === "" ? "." : relative);
	const real = await realpath(candidate).catch(() => undefined);
	if (real === undefined) throw new Error("no such file or directory");
	if (!isWithin(realRoot, real)) throw new Error("path escapes the workspace");
	return { root: realRoot, realRoot, path: real };
}

function relativeOf(root, path) {
	if (path === root) return "";
	return path.slice(root.length + 1).split(sep).join("/");
}

function hrefFor(base, index, relative) {
	return `${base}?w=${String(index)}&p=${encodeURIComponent(relative)}`;
}

function pageShell(title, body) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 14px calc(24px + env(safe-area-inset-bottom)); font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; background: #16181c; color: #e8eaed; }
  a { color: #8ab4f8; text-decoration: none; }
  header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .grow { flex: 1 1 auto; }
  select, button { font: inherit; color: inherit; background: #262a31; border: 1px solid #3c424b; border-radius: 8px; padding: 8px 10px; }
  button { cursor: pointer; }
  button:active { background: #333842; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0 10px; }
  a.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; background: #262a31; border: 1px solid #3c424b; color: inherit; }
  a.btn:active { background: #333842; }
  .crumbs { margin: 0 0 10px; font-size: 14px; color: #b6bcc6; word-break: break-all; }
  .crumbs a { color: #8ab4f8; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-bottom: 1px solid #24272d; }
  li a, li span.row { display: flex; align-items: center; gap: 10px; padding: 12px 4px; min-height: 46px; }
  li a { color: inherit; }
  .icon { width: 20px; text-align: center; flex: none; opacity: .85; }
  .label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; font-size: 12px; color: #8b929d; text-align: right; }
  .empty, .error { padding: 24px 4px; color: #c8ccd4; }
  .error { color: #f28b82; }
  .hint { margin-top: 16px; font-size: 12px; color: #7c838d; }
  #toast { position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom)); transform: translateX(-50%); background: #2c313a; border: 1px solid #3c424b; border-radius: 10px; padding: 10px 14px; font-size: 13px; opacity: 0; transition: opacity .18s; pointer-events: none; max-width: 90vw; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
${body}
<div id="toast"></div>
<script>
function toast(message) {
  var el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
}
async function revealFolder(index, path) {
  try {
    var response = await fetch('${OPEN_PATH}?w=' + index + '&p=' + encodeURIComponent(path), { method: 'POST' });
    var data = await response.json().catch(function () { return {}; });
    toast(response.ok ? ('已在本机打开：' + (data.path || '')) : ('打开失败：' + (data.error || response.status)));
  } catch (error) {
    toast('打开失败：' + error.message);
  }
}
</script>
</body>
</html>`;
}

async function renderPage(ctx, url) {
	const roots = workspaceRoots(ctx);
	const { index, relative } = readParams(url);

	let selector = "";
	roots.forEach((root, rootIndex) => {
		const selected = rootIndex === index ? " selected" : "";
		selector += `<option value="${String(rootIndex)}"${selected}>${escapeHtml(root.title)}</option>`;
	});

	const header = `<header>
  <h1>工作区文件</h1>
  <span class="grow"></span>
  <select onchange="location.href='${PAGE_PATH}?w=' + this.value">${selector}</select>
</header>`;

	try {
		const target = await resolveTarget(roots, index, relative);
		const info = await stat(target.path);
		if (!info.isDirectory()) {
			return new Response(null, { status: 302, headers: { location: hrefFor(DOWNLOAD_PATH, index, relative) } });
		}

		const entries = (await readdir(target.path, { withFileTypes: true })).slice(0, MAX_ENTRIES);
		const rows = [];
		for (const entry of entries) {
			const childPath = join(target.path, entry.name);
			let childInfo;
			try {
				childInfo = await stat(childPath);
			} catch {
				continue;
			}
			const childRelative = relativeOf(target.root, childPath);
			const isDirectory = childInfo.isDirectory();
			const icon = isDirectory ? "📁" : "📄";
			const meta = isDirectory ? "文件夹" : `${formatBytes(childInfo.size)} · ${formatTime(childInfo.mtimeMs)}`;
			rows.push(
				`<li><a href="${escapeHtml(hrefFor(isDirectory ? PAGE_PATH : DOWNLOAD_PATH, index, childRelative))}">` +
					`<span class="icon">${icon}</span><span class="label">${escapeHtml(entry.name)}${isDirectory ? "/" : ""}</span>` +
					`<span class="meta">${escapeHtml(meta)}</span></a></li>`,
			);
		}

		const currentRelative = relativeOf(target.root, target.path);
		const segments = currentRelative.split("/").filter((segment) => segment !== "");
		let crumbs = `<a href="${escapeHtml(hrefFor(PAGE_PATH, index, ""))}">${escapeHtml(roots[index].title)}</a>`;
		let walked = "";
		segments.forEach((segment) => {
			walked = walked === "" ? segment : `${walked}/${segment}`;
			crumbs += ` / <a href="${escapeHtml(hrefFor(PAGE_PATH, index, walked))}">${escapeHtml(segment)}</a>`;
		});

		const body = `${header}
<div class="crumbs">${crumbs}</div>
<div class="actions">
  <a class="btn" href="${escapeHtml(hrefFor(ZIP_PATH, index, currentRelative))}">⬇ 打包下载（zip）</a>
  <button onclick="revealFolder(${String(index)}, ${JSON.stringify(currentRelative).replaceAll("<", "\\u003c")})">📂 在资源管理器中打开</button>
</div>
${rows.length === 0 ? '<p class="empty">这个文件夹是空的。</p>' : `<ul>${rows.join("")}</ul>`}
<p class="hint">点文件直接下载；点文件夹继续浏览；「打包下载」会把这个文件夹压成 zip。这里列出的就是 DSH 认识的各个工作区。</p>`;
		return new Response(pageShell("工作区文件", body), {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const body = `${header}<p class="error">无法打开：${escapeHtml(message)}</p>
<p class="hint"><a href="${escapeHtml(hrefFor(PAGE_PATH, 0, ""))}">回到工作区根目录</a></p>`;
		return new Response(pageShell("工作区文件", body), {
			status: 404,
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
		});
	}
}

async function downloadFile(ctx, url) {
	const roots = workspaceRoots(ctx);
	const { index, relative } = readParams(url);
	try {
		const target = await resolveTarget(roots, index, relative);
		const info = await stat(target.path);
		if (!info.isFile()) return new Response("not a file", { status: 400 });
		const stream = Readable.toWeb(createReadStream(target.path));
		return new Response(stream, {
			headers: {
				"content-type": contentTypesForPath(target.path),
				"content-length": String(info.size),
				"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(target.path))}`,
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Response(message, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
}

async function zipTarget(ctx, url) {
	const roots = workspaceRoots(ctx);
	const { index, relative } = readParams(url);
	try {
		const target = await resolveTarget(roots, index, relative);
		const info = await stat(target.path);
		if (info.isFile()) {
			// One file needs no container: hand it to the plain download route.
			return new Response(null, { status: 302, headers: { location: hrefFor(DOWNLOAD_PATH, index, relative) } });
		}
		// Collect before streaming, so the size/entry caps answer with a status.
		const { files } = await collectFiles(target.path);
		const archiveRoot = relative === "" ? "" : basename(target.path);
		const label = relative === "" ? roots[index].title === "" ? basename(target.path) : roots[index].title : basename(target.path);
		const body = Readable.from(zipFiles(files, archiveRoot));
		return new Response(body, {
			headers: {
				"content-type": "application/zip",
				"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${label}.zip`)}`,
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = /too large|too many/iu.test(message) ? 413 : 404;
		return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
}

function revealInFileManager(path) {
	const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
	const child = spawn(command, [path], { detached: true, stdio: "ignore" });
	child.unref();
}

async function openTarget(ctx, url) {
	if (process.platform === "linux" && process.env.DISPLAY === undefined) {
		return Response.json({ ok: false, error: "no desktop session on the host" }, { status: 501 });
	}
	const roots = workspaceRoots(ctx);
	const { index, relative } = readParams(url);
	try {
		const target = await resolveTarget(roots, index, relative);
		const info = await stat(target.path);
		const folder = info.isDirectory() ? target.path : dirname(target.path);
		revealInFileManager(folder);
		return Response.json({ ok: true, path: folder });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ ok: false, error: message }, { status: 404 });
	}
}

/**
 * Register the workspace-file routes on the Connection transport.
 * @param ctx - plugin context carrying `connection` and `workspaceRegistry`.
 */
function registerWorkspaceFiles(ctx) {
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: PAGE_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: (request) => renderPage(ctx, new URL(request.url)),
			}),
		"mobile-shell: workspace files page",
	);
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: DOWNLOAD_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: (request) => downloadFile(ctx, new URL(request.url)),
			}),
		"mobile-shell: workspace file download",
	);
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ZIP_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: (request) => zipTarget(ctx, new URL(request.url)),
			}),
		"mobile-shell: workspace folder zip",
	);
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: OPEN_PATH,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: (request) => openTarget(ctx, new URL(request.url)),
			}),
		"mobile-shell: reveal workspace folder",
	);
}

/** Exposed for the smoke test (path guard + escaping are the risky parts). */
const internals = { escapeHtml, formatBytes, isWithin, readParams, relativeOf, contentTypesForPath };

export { internals, PAGE_PATH, registerWorkspaceFiles };
