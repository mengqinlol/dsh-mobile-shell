// Smoke test: mount the plugin against a fake context, assert the index-tap
// payload, then exercise the workspace-file routes on a temporary workspace.
// Run with `npm test` (Node 22+, no dependencies).
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");

assert.equal(plugin.name, "dsh-mobile-shell");
assert.deepEqual(plugin.inject, ["webServer", "connection", "workspaceRegistry"]);

// ---------------------------------------------------------------- index tap ----

const taps = [];
const routes = new Map();
const workspace = mkdtempSync(join(tmpdir(), "dsh-mobile-shell-"));
writeFileSync(join(workspace, "hello.txt"), "hello workspace\n");
writeFileSync(join(workspace, "数据.csv"), "a,b\n1,2\n");

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

assert.equal(taps.length, 1, "apply() must register exactly one index tap");
const html = taps[0]('<html><head><title>t</title></head><body></body></html>');

assert.ok(html.includes("crypto.randomUUID"), "polyfill missing");
assert.ok(html.includes("</style>"), "stylesheet missing");
assert.ok(html.includes("__dshMobileShell"), "shell script missing");
assert.ok(html.includes("--dsh-keyboard-inset"), "mobile stylesheet is stale/empty");
assert.ok(html.includes("max-width: 820px") || html.includes("max-width:820px"), "media query missing");
assert.ok(!html.includes("data-lan-device"), "upstream typography layer must not be injected");

// Idempotence: a page that already carries the polyfill is left alone.
assert.equal(taps[0](html), html, "index tap is not idempotent");

// ------------------------------------------------------------ file routes ----

assert.equal(routes.size, 3, "expected three workspace-file routes");
const page = routes.get("GET /api/workspace-files");
const download = routes.get("GET /api/workspace-files.download");
const open = routes.get("POST /api/workspace-files.open");
assert.ok(page !== undefined && download !== undefined && open !== undefined, "route paths changed");

const pageResponse = await page.fetch(new Request("http://x/api/workspace-files?w=0&p="));
assert.equal(pageResponse.status, 200);
const pageHtml = await pageResponse.text();
assert.ok(pageHtml.includes("hello.txt"), "page must list hello.txt");
assert.ok(pageHtml.includes("workspace-files.download"), "page must link downloads");
assert.ok(pageHtml.includes("在资源管理器中打开"), "page must offer reveal");

const fileResponse = await download.fetch(new Request("http://x/api/workspace-files.download?w=0&p=hello.txt"));
assert.equal(fileResponse.status, 200);
assert.equal(await fileResponse.text(), "hello workspace\n");
assert.match(fileResponse.headers.get("content-disposition") ?? "", /attachment/);
assert.match(fileResponse.headers.get("content-disposition") ?? "", /hello\.txt/);

const unicodeResponse = await download.fetch(
  new Request(`http://x/api/workspace-files.download?w=0&p=${encodeURIComponent("数据.csv")}`),
);
assert.equal(unicodeResponse.status, 200);

for (const probe of [
  "http://x/api/workspace-files?w=0&p=../",
  "http://x/api/workspace-files.download?w=0&p=../../Windows/win.ini",
  "http://x/api/workspace-files?w=9&p=",
  "http://x/api/workspace-files.download?w=0&p=nope.txt",
]) {
  const route = probe.includes("download") ? download : page;
  const response = await route.fetch(new Request(probe));
  assert.ok(response.status >= 400, `${probe} should be refused, got ${response.status}`);
}

// A directory asked through the page renders; a file redirects to the download.
const dirRedirect = await page.fetch(
  new Request(`http://x/api/workspace-files?w=0&p=${encodeURIComponent("数据.csv")}`),
);
assert.equal(dirRedirect.status, 302);

rmSync(workspace, { recursive: true, force: true });
console.log(`ok - index tap ${html.length} bytes, 3 routes, page/download/guards verified`);
