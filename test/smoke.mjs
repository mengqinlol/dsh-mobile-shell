// Smoke test: mount the plugin against a fake webserver context and assert what
// it injects. Run with `npm test` (needs Node 22+; no dependencies).
import { strict as assert } from "node:assert";

const plugin = await import("../lib/index.js");

assert.equal(plugin.name, "dsh-mobile-shell");
assert.deepEqual(plugin.inject, ["webServer"]);

const taps = [];
plugin.apply({ webServer: { tapIndex: (transform) => taps.push(transform) } });
assert.equal(taps.length, 1, "apply() must register exactly one index tap");

const html = taps[0]('<html><head><title>t</title></head><body></body></html>');

assert.ok(html.includes("crypto.randomUUID"), "polyfill missing");
assert.ok(html.includes("</style>"), "stylesheet missing");
assert.ok(html.includes("__dshMobileShell"), "shell script missing");
assert.ok(html.includes("--dsh-keyboard-inset"), "mobile stylesheet is stale/empty");
assert.ok(html.includes("max-width: 820px") || html.includes("max-width:820px"), "media query missing");
assert.ok(!html.includes("data-lan-device"), "upstream typography layer must not be injected");

// Idempotence: a page that already carries the polyfill is left alone.
const again = taps[0](html);
assert.equal(again, html, "index tap is not idempotent");

console.log("ok - injected bytes:", html.length);
