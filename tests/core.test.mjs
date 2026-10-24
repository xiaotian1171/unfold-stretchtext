import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Core = require("../extension/lib/core.js");
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("selection validation normalizes and bounds text", () => {
  assert.equal(Core.normalizeText("  a\u00a0  b\n\n\n c "), "a b\n\n c");
  assert.equal(Core.validateSelectionText(" x ").code, "TOO_SHORT");
  assert.equal(Core.validateSelectionText("chosen words").ok, true);
  assert.equal(Core.validateSelectionText("x".repeat(8001)).code, "TOO_LONG");
});

test("target lengths make shrink smaller and keep grow bounded", () => {
  const passage = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  assert.ok(Core.targetWords("shrink", passage) <= 180);
  assert.ok(Core.targetWords("grow", passage) <= 420);
  assert.ok(Core.estimateMaxTokens("grow", passage) <= 1100);
  assert.ok(Core.estimateMaxTokens("grow", "chosen words") >= 320);
});

test("prompts encode stretchtext behavior and JSON-only output", () => {
  const messages = Core.buildMessages({
    action: "grow",
    text: "A dense claim.",
    context: "A dense claim. More context follows.",
    insertionMode: "inline",
    depth: 1,
    pageTitle: "Example",
  });
  const joined = messages.map((message) => message.content).join("\n");
  assert.match(joined, /Do not repeat the selected text/);
  assert.match(joined, /Return JSON only/);
  assert.match(joined, /do not invent citations/i);
  assert.match(joined, /inserted inline/);
});

test("response parsing accepts JSON, fenced JSON and plain text", () => {
  assert.equal(Core.parseTransformContent('{"text":"Expanded."}'), "Expanded.");
  assert.equal(Core.parseTransformContent("```json\n{\"text\":\"Fenced.\"}\n```"), "Fenced.");
  assert.equal(Core.parseTransformContent('Here is it: {"text":"Embedded."}'), "Embedded.");
  assert.equal(Core.parseTransformContent("Plain result."), "Plain result.");
  assert.equal(Core.parseTransformContent([{ text: "Part one." }, { text: "Part two." }]), "Part one.\nPart two.");
});

test("cache keys are stable and sensitive to action, model and depth", () => {
  const base = { action: "grow", model: "m1", text: "Hello   world", depth: 0 };
  assert.equal(Core.cacheKey(base), Core.cacheKey({ ...base, text: "Hello world" }));
  assert.notEqual(Core.cacheKey(base), Core.cacheKey({ ...base, action: "shrink" }));
  assert.notEqual(Core.cacheKey(base), Core.cacheKey({ ...base, model: "m2" }));
  assert.notEqual(Core.cacheKey(base), Core.cacheKey({ ...base, depth: 1 }));
});

test("manifest references real files and keeps API host access narrow", () => {
  const root = new URL("../extension/", import.meta.url);
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...entry.css]),
    ...Object.values(manifest.icons),
  ];
  for (const ref of refs) assert.ok(existsSync(new URL(ref, root)), `missing ${ref}`);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "https://enter.pollinations.ai/*",
    "https://gen.pollinations.ai/*",
  ]);
  assert.ok(!manifest.permissions.includes("history"));
  assert.ok(!manifest.permissions.includes("cookies"));
});

test("key handling stays in the background and generated DOM is text-only", () => {
  assert.match(background, /UNFOLD_OPEN_OPTIONS/);
  assert.match(background, /Authorization: `Bearer \$\{auth\.apiKey\}`/);
  assert.match(background, /reasoning_effort:\s*"none"/);
  assert.doesNotMatch(content, /Authorization|apiKey/);
  assert.match(content, /textContent = resultText/);
  assert.doesNotMatch(content, /innerHTML\s*=\s*resultText/);
  assert.match(content, /restorePage/);
  assert.match(readme, /badge-made-with\.svg/);
});
