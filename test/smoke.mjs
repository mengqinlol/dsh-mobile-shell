// Smoke test: mount the plugin against a fake context, assert the index-tap
// payload, then exercise the workspace routes (browse / preview / range /
// download / zip / reveal) on a temporary workspace, including a real ZIP parse.
// Run with `npm test` (Node 22+, no dependencies).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const plugin = await import("../lib/index.js");

assert.equal(plugin.name, "dsh-mobile-shell");
assert.deepEqual(plugin.inject, ["webServer", "connection", "workspaceRegistry"]);

// ---------------------------------------------------------------- fixtures ----

const workspace = mkdtempSync(join(tmpdir(), "dsh-mobile-shell-"));
writeFileSync(join(workspace, "hello.txt"), "hello workspace\n");
writeFileSync(join(workspace, "数据.csv"), "a,b\n1,2\n");
writeFileSync(join(workspace, "note.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
writeFileSync(join(workspace, "clip.mp4"), Buffer.alloc(2048, 0x41));
writeFileSync(join(workspace, "blob.bin"), Buffer.alloc(16, 0x00));
mkdirSync(join(workspace, "sub"));
writeFileSync(join(workspace, "sub", "inner.txt"), "inner file\n");

// A second workspace, owned by the "current" session, to check the default.
const otherWorkspace = mkdtempSync(join(tmpdir(), "dsh-mobile-shell-other-"));
writeFileSync(join(otherWorkspace, "only-second.txt"), "second workspace\n");

/** Read central-directory entries out of an archive produced by lib/zip.js. */
function readZipEntries(buffer) {
	let end = -1;
	for (let at = buffer.length - 22; at >= 0; at -= 1) {
		if (buffer.readUInt32LE(at) === 0x06054b50) {
			end = at;
			break;
		}
	}
	assert.notEqual(end, -1, "no end-of-central-directory record");
	const count = buffer.readUInt16LE(end + 10);
	let offset = buffer.readUInt32LE(end + 16);
	const entries = [];
	for (let index = 0; index < count; index += 1) {
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		entries.push({
			name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
			method: buffer.readUInt16LE(offset + 10),
			compressedSize: buffer.readUInt32LE(offset + 20),
			size: buffer.readUInt32LE(offset + 24),
			localOffset: buffer.readUInt32LE(offset + 42),
		});
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function extractEntry(buffer, entry) {
	const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
	const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
	const start = entry.localOffset + 30 + nameLength + extraLength;
	const data = buffer.subarray(start, start + entry.compressedSize);
	return Buffer.from(entry.method === 8 ? inflateRawSync(data) : data);
}

// ------------------------------------------------------------------ mount ----

const taps = [];
const routes = new Map();
const ctx = {
	webServer: { tapIndex: (transform) => taps.push(transform) },
	workspaceRegistry: {
		list: () => [
			{ title: "first", path: workspace, sessionIds: ["session-other"], createdAt: "", updatedAt: "" },
			{ title: "default-workspace", path: otherWorkspace, sessionIds: ["session-current"], createdAt: "", updatedAt: "" },
		],
	},
	connection: {
		fetch: {
			register(route) {
				routes.set(`${route.methods.join(",")} ${route.path}`, route);
				return () => routes.delete(route.path);
			},
		},
	},
	effect(factory) {
		factory();
	},
};
plugin.apply(ctx);

// ---------------------------------------------------------------- index tap ----

assert.equal(taps.length, 1, "apply() must register exactly one index tap");
const html = taps[0]('<html><head><title>t</title></head><body></body></html>');
assert.ok(html.includes("crypto.randomUUID"), "polyfill missing");
assert.ok(html.includes("</style>"), "stylesheet missing");
assert.ok(html.includes("__dshMobileShell"), "shell script missing");
assert.ok(html.includes("--dsh-keyboard-inset"), "mobile stylesheet is stale/empty");
assert.ok(!html.includes("data-lan-device"), "upstream typography layer must not be injected");
assert.equal(taps[0](html), html, "index tap is not idempotent");

// ------------------------------------------------------------------- routes ----

assert.equal(routes.size, 5, "expected five workspace routes");
const page = routes.get("GET /api/workspace-files");
const view = routes.get("GET /api/workspace-files.view");
const download = routes.get("GET /api/workspace-files.download");
const zip = routes.get("GET /api/workspace-files.zip");
const open = routes.get("POST /api/workspace-files.open");
assert.ok(page && view && download && zip && open, "route paths changed");

const pageResponse = await page.fetch(new Request("http://x/api/workspace-files?w=0&p="));
assert.equal(pageResponse.status, 200);
const pageHtml = await pageResponse.text();
assert.ok(pageHtml.includes("hello.txt"), "page must list hello.txt");
assert.ok(pageHtml.includes("sub/"), "page must list the sub directory");
assert.ok(pageHtml.includes("workspace-files.zip"), "page must link the folder zip");
assert.ok(pageHtml.includes("在资源管理器中打开"), "page must offer reveal");

// The session decides the default workspace; an explicit w still wins.
const sessionPage = await page.fetch(new Request("http://x/api/workspace-files?session=session-current"));
const sessionHtml = await sessionPage.text();
assert.ok(sessionHtml.includes("only-second.txt"), "session default must open its own workspace");
assert.ok(!sessionHtml.includes("hello.txt"), "session default must not open the first workspace");
// The automatic title renders as the localized default name, like the GUI does.
assert.ok(sessionHtml.includes("默认工作区"), "default workspace must show the localized label");
assert.ok(!sessionHtml.includes(">default-workspace<"), "raw automatic title must not leak into the UI");

const otherSession = await page.fetch(new Request("http://x/api/workspace-files?session=session-other"));
assert.ok((await otherSession.text()).includes("hello.txt"), "other session must open the first workspace");

const explicit = await page.fetch(new Request("http://x/api/workspace-files?session=session-current&w=0"));
assert.ok((await explicit.text()).includes("hello.txt"), "explicit w must override the session default");

const noParams = await page.fetch(new Request("http://x/api/workspace-files"));
assert.ok((await noParams.text()).includes("hello.txt"), "without hints the first workspace is used");

// An out-of-range w (stale bookmark) falls back to the first workspace.
const staleIndex = await page.fetch(new Request("http://x/api/workspace-files?w=9"));
assert.equal(staleIndex.status, 200);
assert.ok((await staleIndex.text()).includes("hello.txt"), "stale workspace index should fall back");

// ------------------------------------------------------------- preview pages ----

const textView = await page.fetch(new Request("http://x/api/workspace-files?w=0&p=hello.txt"));
assert.equal(textView.status, 200, "a file opens the viewer instead of downloading");
const textHtml = await textView.text();
assert.ok(textHtml.includes('class="preview text"'), "text preview missing");
assert.ok(textHtml.includes("hello workspace"), "text content missing");
assert.ok(textHtml.includes("workspace-files.download"), "viewer must keep a download button");

const imageView = await page.fetch(new Request("http://x/api/workspace-files?w=0&p=note.png"));
assert.ok((await imageView.text()).includes('<img src="/api/workspace-files.view'), "image preview missing");

const videoView = await page.fetch(new Request("http://x/api/workspace-files?w=0&p=clip.mp4"));
assert.ok((await videoView.text()).includes("<video controls playsinline"), "video preview missing");

const binaryView = await page.fetch(new Request("http://x/api/workspace-files?w=0&p=blob.bin"));
const binaryHtml = await binaryView.text();
assert.ok(!binaryHtml.includes("<img") && !binaryHtml.includes("<video"), "binary must not attempt a preview");
assert.ok(binaryHtml.includes("不支持内联预览"), "binary should say preview is unsupported");

// ------------------------------------------------------------ inline + range ----

const inline = await view.fetch(new Request("http://x/api/workspace-files.view?w=0&p=clip.mp4"));
assert.equal(inline.status, 200);
assert.equal(inline.headers.get("content-type"), "video/mp4");
assert.match(inline.headers.get("content-disposition") ?? "", /^inline;/u);
assert.equal(inline.headers.get("accept-ranges"), "bytes");
assert.equal(inline.headers.get("content-length"), "2048");

const partial = await view.fetch(
	new Request("http://x/api/workspace-files.view?w=0&p=clip.mp4", { headers: { range: "bytes=0-99" } }),
);
assert.equal(partial.status, 206);
assert.equal(partial.headers.get("content-range"), "bytes 0-99/2048");
assert.equal(partial.headers.get("content-length"), "100");
assert.equal((await partial.arrayBuffer()).byteLength, 100);

const suffix = await view.fetch(
	new Request("http://x/api/workspace-files.view?w=0&p=clip.mp4", { headers: { range: "bytes=-64" } }),
);
assert.equal(suffix.status, 206);
assert.equal(suffix.headers.get("content-range"), "bytes 1984-2047/2048");

const unsatisfiable = await view.fetch(
	new Request("http://x/api/workspace-files.view?w=0&p=clip.mp4", { headers: { range: "bytes=5000-6000" } }),
);
assert.equal(unsatisfiable.status, 416);
assert.equal(unsatisfiable.headers.get("content-range"), "bytes */2048");

// ----------------------------------------------------------------- download ----

const fileResponse = await download.fetch(new Request("http://x/api/workspace-files.download?w=0&p=hello.txt"));
assert.equal(fileResponse.status, 200);
assert.equal(await fileResponse.text(), "hello workspace\n");
assert.match(fileResponse.headers.get("content-disposition") ?? "", /attachment; filename\*=UTF-8''hello\.txt/);

const unicodeResponse = await download.fetch(
	new Request(`http://x/api/workspace-files.download?w=0&p=${encodeURIComponent("数据.csv")}`),
);
assert.equal(unicodeResponse.status, 200);

// ---------------------------------------------------------------------- zip ----

const zipResponse = await zip.fetch(new Request("http://x/api/workspace-files.zip?w=0&p="));
assert.equal(zipResponse.status, 200);
assert.equal(zipResponse.headers.get("content-type"), "application/zip");
const archive = Buffer.from(await zipResponse.arrayBuffer());
const names = readZipEntries(archive).map((entry) => entry.name).sort();
assert.deepEqual(names, ["blob.bin", "clip.mp4", "hello.txt", "note.png", "sub/inner.txt", "数据.csv"]);
const innerEntry = readZipEntries(archive).find((entry) => entry.name === "sub/inner.txt");
assert.equal(extractEntry(archive, innerEntry).toString("utf8"), "inner file\n");

const subZip = await zip.fetch(new Request("http://x/api/workspace-files.zip?w=0&p=sub"));
assert.deepEqual(readZipEntries(Buffer.from(await subZip.arrayBuffer())).map((entry) => entry.name), ["sub/inner.txt"]);

assert.equal((await zip.fetch(new Request("http://x/api/workspace-files.zip?w=0&p=hello.txt"))).status, 302);

// ------------------------------------------------------------------- guards ----

for (const [route, probe] of [
	[page, "http://x/api/workspace-files?w=0&p=../"],
	[view, "http://x/api/workspace-files.view?w=0&p=../../Windows/win.ini"],
	[download, "http://x/api/workspace-files.download?w=0&p=../../Windows/win.ini"],
	[zip, "http://x/api/workspace-files.zip?w=0&p=.."],
]) {
	const response = await route.fetch(new Request(probe));
	assert.ok(response.status >= 400, `${probe} should be refused, got ${response.status}`);
}

// -------------------------------------------------------------- pure helpers ----

const { isWithin, escapeHtml, contentTypesForPath, relativeOf } = plugin.workspaceFiles.internals;
assert.equal(isWithin(workspace, join(workspace, "a", "b")), true);
assert.equal(isWithin(workspace, join(workspace, "..", "outside")), false);
assert.equal(escapeHtml('<img src=x onerror="1">'), "&lt;img src=x onerror=&quot;1&quot;&gt;");
assert.equal(contentTypesForPath("a.png"), "image/png");
assert.equal(relativeOf(workspace, join(workspace, "a", "b.txt")), "a/b.txt");

rmSync(workspace, { recursive: true, force: true });
console.log(`ok - index tap ${html.length} bytes, 5 routes, preview + range + zip + guards verified`);
