import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { loadManifest } from "../manifest.ts";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR for installed Pi skill discovery.";
const sharedSkills = resolve("../.agents/skills");
const coreSkills = ["development-workflow", "engineering-practices", "agent-tools"];
const retiredSkills = ["architecture-design", "create-specification", "review", "diagrams", "code-style-guidelines", "verification", "subagent-orchestration"];
const referencePath = join(sharedSkills, "agent-tools/references/pi-subagents.md");

test("Pi discovers the three core skills, not retired entries or references, including after reload", { skip }, async () => {
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  // Empty in-memory package settings prevent downloads and preserve personal settings.
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: resolve("agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  for (let reload = 0; reload < 2; reload++) {
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    for (const name of coreSkills) {
      const directory = join(sharedSkills, name);
      const matches = skills.filter(skill => skill.name === name);
      assert.equal(matches.length, 1, `Expected one ${name} skill`);
      assert.equal(resolve(matches[0].filePath), join(directory, "SKILL.md"));
      const entries = skills.filter(skill => resolve(skill.filePath).startsWith(`${directory}${sep}`));
      assert.deepEqual(entries.map(skill => resolve(skill.filePath)), [join(directory, "SKILL.md")], `References under ${name} must not become skills`);
    }
    for (const name of retiredSkills) {
      assert.ok(!skills.some(skill => skill.name === name), `Retired skill ${name} is still discoverable`);
    }
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(loader.getExtensions().errors, []);
  }
});

test("personal extension exclusions remove desktop notification commands, tools and prompt hooks on reload", { skip }, async () => {
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const settings = JSON.parse(await readFile(resolve("agent/settings.json"), "utf8"));
  // Exercise actual personal exclusions, without loading packages or connecting integrations.
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: resolve("agent"),
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: settings.extensions }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  for (let reload = 0; reload < 2; reload++) {
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.ok(extensions.some(extension => resolve(extension.path) === resolve("agent/extensions/goal-loop/index.ts")), "Other extensions must remain enabled");
    assert.ok(!extensions.some(extension => resolve(extension.path) === resolve("agent/extensions/notifications/index.ts")), "Notification prompt hooks must not be loaded");
    for (const extension of extensions) {
      assert.equal(extension.commands.has("notify"), false);
      assert.equal(extension.tools.has("notify_send"), false);
      assert.equal(extension.tools.has("notify_checkpoint"), false);
    }
  }
});

test("relative Markdown links in core skills, references and their READMEs resolve", async () => {
  const files = [resolve("README.md"), resolve("../.agents/README.md")];
  for (const name of coreSkills) {
    const directory = join(sharedSkills, name);
    files.push(...(await readdir(directory, { recursive: true })).filter(file => file.endsWith(".md")).map(file => join(directory, file)));
  }
  for (const file of files) {
    const markdown = (await readFile(file, "utf8")).replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "");
    for (const [, href] of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(href)) continue;
      const target = resolve(dirname(file), decodeURIComponent(href.split(/[?#]/, 1)[0]));
      await assert.doesNotReject(() => access(target), `${file} links to missing target ${href}`);
    }
  }
});

test("Pi subagent reference examples submit valid fixed manifests through registered tool names", { skip }, async t => {
  const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(root, "dist/core/event-bus.js")).href);
  const loaded = await loadExtensions([resolve("agent/extensions/simple-subagents/index.ts")], process.cwd(), createEventBus());
  assert.deepEqual(loaded.errors, []);
  const registered = loaded.extensions[0].tools;
  const reference = await readFile(referencePath, "utf8");
  for (const name of new Set(reference.match(/\b(?:swarm|subagent)_(?:start|status|results|pause|resume|stop|steer)\b/g))) {
    assert.ok(registered.has(name), `Reference names unregistered tool ${name}`);
  }
  const inputs = [];
  for (const [, example] of reference.matchAll(/```javascript\r?\n([\s\S]*?)```/g)) {
    runInNewContext(example, { swarm_start: input => inputs.push(JSON.parse(JSON.stringify(input))) }, { timeout: 1000 });
  }
  assert.equal(inputs.length, 2);
  const directory = await mkdtemp(resolve("agent/extensions/simple-subagents/test/.tmp-skill-"));
  t.after(async () => { assert.equal(await realpath(directory), directory); await rm(directory, { recursive: true }); });
  const csv = reference.match(/```csv\r?\n([\s\S]*?)```/)[1];
  await writeFile(join(directory, "tasks.csv"), csv);
  for (const input of inputs) {
    const manifest = await loadManifest(input, directory);
    assert.equal(manifest.length, 2);
    assert.equal(input.agent, "scout");
    assert.equal(input.maxParallel, 2);
  }
});
