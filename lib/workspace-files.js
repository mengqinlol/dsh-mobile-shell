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
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { collectFiles, zipFiles } from "./zip.js";

const PAGE_PATH = "/api/workspace-files";
const DOWNLOAD_PATH = "/api/workspace-files.download";
const OPEN_PATH = "/api/workspace-files.open";
const ZIP_PATH = "/api/workspace-files.zip";
const VIEW_PATH = "/api/workspace-files.view";

/** Text previews are inlined; bigger files stay download-only. */
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Extensions the viewer renders in place, by preview kind. */
const PREVIEW_KINDS = new Map([
	...[".txt", ".md", ".markdown", ".json", ".jsonl", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".html", ".htm", ".xml", ".csv", ".tsv", ".log", ".yml", ".yaml", ".ini", ".cfg", ".conf", ".toml", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sql", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".gitignore", ".dockerignore", ".editorconfig", ".gitattributes"].map((extension) => [extension, "text"]),
	...[".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"].map((extension) => [extension, "image"]),
	...[".mp4", ".m4v", ".webm", ".mov", ".ogv"].map((extension) => [extension, "video"]),
	...[".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".flac"].map((extension) => [extension, "audio"]),
	[".pdf", "pdf"],
]);

/** Preview kind for a file name, or undefined when it cannot be previewed. */
function previewKindFor(path) {
	return PREVIEW_KINDS.get(extname(path).toLowerCase());
}

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

const FALLBACK_PAGE_TEMPLATE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{{TITLE}}</title>
<style>
  :root { color-scheme: dark; --bg:#16181c; --fg:#e8eaed; --muted:#8b929d; --line:#24272d; --ctl:#262a31; --ctl-border:#3c424b; --link:#8ab4f8; }
  html[data-dsh-theme="light"] { color-scheme: light; --bg:#ffffff; --fg:#1f2328; --muted:#6e7781; --line:#eaecef; --ctl:#f6f8fa; --ctl-border:#d0d7de; --link:#0969da; }
  body { margin:0; padding:16px 14px; font:15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  a { color: var(--link); }
</style></head>
<body>{{BODY}}<div id="toast"></div>
<script>function toast(m){var e=document.getElementById('toast');if(!e)return;e.textContent=m;e.style.cssText='position:fixed;left:50%;bottom:20px;transform:translateX(-50%);padding:8px 12px;border-radius:8px;background:var(--ctl)';}</script>
</body></html>`;

/**
 * Render the page shell from assets/files-page.html (read per request, so the
 * markup and styling can be edited without restarting the server).
 * @param readAsset - asset reader supplied by the plugin entry.
 */
function pageShell(readAsset, title, body) {
	const template = readAsset("files-page.html") || FALLBACK_PAGE_TEMPLATE;
	return template
		.split("{{TITLE}}").join(escapeHtml(title))
		.split("{{BODY}}").join(body)
		.split("{{OPEN_PATH}}").join(OPEN_PATH);
}

/** Shared response helper for both the page and its error variant. */
function pageResponse(readAsset, title, body, status = 200) {
	return new Response(pageShell(readAsset, title, body), {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}
async function renderPage(ctx, readAsset, url) {
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
			return await renderViewer(readAsset, { roots, index, relative, target, info });
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
			const kind = isDirectory ? undefined : previewKindFor(childPath);
			const icon = isDirectory ? "📁" : kind === "image" ? "🖼" : kind === "video" ? "🎬" : kind === "audio" ? "🎵" : kind === "pdf" ? "📕" : "📄";
			const meta = isDirectory ? "文件夹" : `${formatBytes(childInfo.size)} · ${formatTime(childInfo.mtimeMs)}`;
			// Files open the viewer first: it previews what it can and offers the
			// download button for everything else.
			rows.push(
				`<li><a href="${escapeHtml(hrefFor(PAGE_PATH, index, childRelative))}">` +
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
<p class="hint">点文件夹继续浏览；点文件进入预览（文本 / 图片 / 音视频 / PDF 可直接看，其余给下载按钮）；「打包下载」会把这个文件夹压成 zip。</p>`;
		return pageResponse(readAsset, "工作区文件", body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const body = `${header}<p class="error">无法打开：${escapeHtml(message)}</p>
<p class="hint"><a href="${escapeHtml(hrefFor(PAGE_PATH, 0, ""))}">回到工作区根目录</a></p>`;
		return pageResponse(readAsset, "工作区文件", body, 404);
	}
}

/**
 * Render the viewer for one file: inline preview when the type allows it, and a
 * download button in every case.
 */
async function renderViewer(readAsset, { roots, index, relative, target, info }) {
	const name = basename(target.path);
	const slash = relative.lastIndexOf("/");
	const parentRelative = slash === -1 ? "" : relative.slice(0, slash);
	const kind = previewKindFor(target.path);
	const viewHref = hrefFor(VIEW_PATH, index, relative);
	const header = `<header>
  <a class="back" href="${escapeHtml(hrefFor(PAGE_PATH, index, parentRelative))}">← 返回</a>
  <h1 title="${escapeHtml(name)}">${escapeHtml(name)}</h1>
</header>
<div class="crumbs">${escapeHtml(formatBytes(info.size))} · ${escapeHtml(formatTime(info.mtimeMs))}${kind === undefined ? "" : ` · ${escapeHtml(kind)}`}</div>
<div class="actions">
  <a class="btn" href="${escapeHtml(hrefFor(DOWNLOAD_PATH, index, relative))}">⬇ 下载</a>
  <button onclick="revealFolder(${String(index)}, ${JSON.stringify(parentRelative).replaceAll("<", "\\u003c")})">📂 打开所在文件夹</button>
</div>`;

	let preview;
	if (kind === "text") {
		if (info.size > MAX_TEXT_PREVIEW_BYTES) {
			preview = `<p class="hint">文件有 ${escapeHtml(formatBytes(info.size))}，超过 2 MB 的内联上限，请下载后查看。</p>`;
		} else {
			const text = await readFile(target.path, "utf8").catch(() => "");
			preview = `<pre class="preview text">${escapeHtml(text)}</pre>`;
		}
	} else if (kind === "image") {
		preview = `<div class="preview media"><img src="${escapeHtml(viewHref)}" alt="${escapeHtml(name)}"></div>`;
	} else if (kind === "video") {
		preview = `<div class="preview media"><video controls playsinline preload="metadata" src="${escapeHtml(viewHref)}"></video></div>`;
	} else if (kind === "audio") {
		preview = `<div class="preview media"><audio controls preload="metadata" src="${escapeHtml(viewHref)}"></audio></div>`;
	} else if (kind === "pdf") {
		preview = `<div class="preview doc"><iframe src="${escapeHtml(viewHref)}" title="${escapeHtml(name)}"></iframe></div>`;
	} else {
		preview = `<p class="hint">这个类型不支持内联预览，点上面的「下载」获取文件。</p>`;
	}

	return pageResponse(readAsset, name, header + preview);
}

/**
 * Parse a single-range `Range` header against a size.
 * @returns `{start,end}` for a satisfiable range, `null` for unsatisfiable,
 *   `undefined` when the header is absent or not a byte range we handle.
 */
function parseRange(header, size) {
	if (header === null || header === undefined) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
	if (match === null) return undefined;
	const [, rawStart = "", rawEnd = ""] = match;
	if (rawStart === "" && rawEnd === "") return undefined;
	if (rawStart === "") {
		const suffix = Number(rawEnd);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(rawStart);
	const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
	return { start, end };
}

/**
 * Serve a file inline with byte-range support: browsers need 206 responses to
 * seek inside <video>/<audio> (Safari refuses to play without them).
 */
async function serveInline(ctx, url, request) {
	const roots = workspaceRoots(ctx);
	const { index, relative } = readParams(url);
	try {
		const target = await resolveTarget(roots, index, relative);
		const info = await stat(target.path);
		if (!info.isFile()) return new Response("not a file", { status: 400 });

		const baseHeaders = {
			"content-type": contentTypesForPath(target.path),
			"content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(target.path))}`,
			"accept-ranges": "bytes",
			"cache-control": "no-store",
		};
		const range = parseRange(request.headers.get("range"), info.size);
		if (range === null) {
			return new Response(null, { status: 416, headers: { "content-range": `bytes */${String(info.size)}` } });
		}
		if (range === undefined) {
			return new Response(Readable.toWeb(createReadStream(target.path)), {
				headers: { ...baseHeaders, "content-length": String(info.size) },
			});
		}
		return new Response(Readable.toWeb(createReadStream(target.path, { start: range.start, end: range.end })), {
			status: 206,
			headers: {
				...baseHeaders,
				"content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(info.size)}`,
				"content-length": String(range.end - range.start + 1),
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Response(message, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
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
function registerWorkspaceFiles(ctx, options = {}) {
	const readAsset = typeof options.readAsset === "function" ? options.readAsset : () => "";
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: PAGE_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: (request) => renderPage(ctx, readAsset, new URL(request.url)),
			}),
		"mobile-shell: workspace files page",
	);
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: VIEW_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: (request) => serveInline(ctx, new URL(request.url), request),
			}),
		"mobile-shell: workspace file preview",
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
