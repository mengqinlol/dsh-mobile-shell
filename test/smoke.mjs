// Smoke test: mount the plugin against a fake context, assert the index-tap
// payload, then exercise the workspace file routes (page / download / zip /
// reveal) on a temporary workspace, including a real ZIP parse.
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
mkdirSync(join(workspace, "sub"));
writeFileSync(join(workspace, "sub", "inner.txt"), "inner file\n");

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
			crc: buffer.readUInt32LE(offset + 16),
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
	workspaceRegistry: { list: () => [{ title: "tmp", path: workspace, sessionIds: [], createdAt: "", updatedAt: "" }] },
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

assert.equal(routes.size, 4, "expected four workspace routes");
const page = routes.get("GET /api/workspace-files");
const download = routes.get("GET /api/workspace-files.download");
const zip = routes.get("GET /api/workspace-files.zip");
const open = routes.get("POST /api/workspace-files.open");
assert.ok(page && download && zip && open, "route paths changed");

const pageResponse = await page.fetch(new Request("http://x/api/workspace-files?w=0&p="));
assert.equal(pageResponse.status, 200);
const pageHtml = await pageResponse.text();
assert.ok(pageHtml.includes("hello.txt"), "page must list hello.txt");
assert.ok(pageHtml.includes("sub/"), "page must list the sub directory");
assert.ok(pageHtml.includes("workspace-files.download"), "page must link downloads");
assert.ok(pageHtml.includes("workspace-files.zip"), "page must link the folder zip");
assert.ok(pageHtml.includes("在资源管理器中打开"), "page must offer reveal");

// ----------------------------------------------------------------- download ----

const fileResponse = await download.fetch(new Request("http://x/api/workspace-files.download?w=0&p=hello.txt"));
assert.equal(fileResponse.status, 200);
assert.equal(await fileResponse.text(), "hello workspace\n");
assert.match(fileResponse.headers.get("content-disposition") ?? "", /attachment; filename\*=UTF-8''hello\.txt/);

const unicodeResponse = await download.fetch(
	new Request(`http://x/api/workspace-files.download?w=0&p=${encodeURIComponent("数据.csv")}`),
);
assert.equal(unicodeResponse.status, 200);
assert.match(unicodeResponse.headers.get("content-disposition") ?? "", /%E6%95%B0%E6%8D%AE/);

// ---------------------------------------------------------------------- zip ----

const zipResponse = await zip.fetch(new Request("http://x/api/workspace-files.zip?w=0&p="));
assert.equal(zipResponse.status, 200);
assert.equal(zipResponse.headers.get("content-type"), "application/zip");
assert.match(zipResponse.headers.get("content-disposition") ?? "", /tmp\.zip/);
const archive = Buffer.from(await zipResponse.arrayBuffer());

const entries = readZipEntries(archive);
const names = entries.map((entry) => entry.name).sort();
assert.deepEqual(names, ["hello.txt", "sub/inner.txt", "数据.csv"], `unexpected entries: ${names.join(", ")}`);

const helloEntry = entries.find((entry) => entry.name === "hello.txt");
assert.equal(extractEntry(archive, helloEntry).toString("utf8"), "hello workspace\n");
const innerEntry = entries.find((entry) => entry.name === "sub/inner.txt");
assert.equal(extractEntry(archive, innerEntry).toString("utf8"), "inner file\n");
assert.equal(innerEntry.method, 8, "text files should be deflated");
assert.equal(innerEntry.size, Buffer.byteLength("inner file\n"));

// A sub directory zips under its own name.
const subZip = await zip.fetch(new Request("http://x/api/workspace-files.zip?w=0&p=sub"));
const subArchive = Buffer.from(await subZip.arrayBuffer());
assert.deepEqual(readZipEntries(subArchive).map((entry) => entry.name), ["sub/inner.txt"]);

// A file request redirects to the plain download route.
const fileZip = await zip.fetch(new Request("http://x/api/workspace-files.zip?w=0&p=hello.txt"));
assert.equal(fileZip.status, 302);

// ------------------------------------------------------------------- guards ----

for (const [route, probe] of [
	[page, "http://x/api/workspace-files?w=0&p=../"],
	[download, "http://x/api/workspace-files.download?w=0&p=../../Windows/win.ini"],
	[zip, "http://x/api/workspace-files.zip?w=0&p=.."],
	[page, "http://x/api/workspace-files?w=9&p="],
	[download, "http://x/api/workspace-files.download?w=0&p=nope.txt"],
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
assert.equal(contentTypesForPath("a.unknown"), "application/octet-stream");
assert.equal(relativeOf(workspace, join(workspace, "a", "b.txt")), "a/b.txt");

rmSync(workspace, { recursive: true, force: true });
console.log(`ok - index tap ${html.length} bytes, 4 routes, page/download/zip/guards verified`);
