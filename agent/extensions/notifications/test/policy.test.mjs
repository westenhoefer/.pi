import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskNotification } from "../task.ts";
import { desktopRequest } from "../desktop.ts";
import { ATTENTION_TEXT } from "../contract.ts";

test("only explicit final completion notifies once; waiting and missing checkpoints stay armed", () => {
  const task = new TaskNotification();
  assert.throws(() => task.checkpoint("done"));
  task.start(); assert.equal(task.settled(), undefined);
  task.checkpoint("waiting"); assert.equal(task.settled(), undefined);
  assert.equal(task.active, true);
  task.checkpoint("done"); assert.equal(task.settled(), "task_done");
  assert.equal(task.active, false); assert.equal(task.settled(), undefined);
});

test("input notices deduplicate until user input; stale and cancelled completions never fire", () => {
  const task = new TaskNotification(); task.start();
  assert.equal(task.needsInput(), true);
  task.checkpoint("needs_input"); assert.equal(task.settled(), undefined);
  task.userInput(); task.checkpoint("needs_input"); assert.equal(task.settled(), "task_input");
  task.checkpoint("done"); task.invalidate(); assert.equal(task.settled(), undefined);
  task.checkpoint("done"); task.cancel(); assert.equal(task.settled(), undefined);
});

test("Windows uses an encoded fixed script, including outside Windows Terminal", () => {
  for (const kind of Object.keys(ATTENTION_TEXT)) {
    const request = desktopRequest(kind, { platform: "win32", windowsTerminal: false, kitty: false });
    assert.equal(request.file, "powershell.exe");
    assert.deepEqual(request.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(request.args[3], "base64").toString("utf16le");
    assert.ok(script.includes(ATTENTION_TEXT[kind]));
    assert.match(script, /CreateToastNotifier/);
    assert.match(script, /\$nodes\.Item\(0\)/);
    assert.match(script, /\$nodes\.Item\(1\)/);
    assert.doesNotMatch(script, /GetElementsByTagName\('text'\)\[\d\]|ExecutionPolicy|New-Item|Set-Item/);
  }
  assert.equal(desktopRequest("task_done", { platform: "linux", windowsTerminal: true, kitty: false }).file, "powershell.exe");
});

test("terminal backends send only fixed statuses; unsupported environments fail visibly", () => {
  const env = { platform: "linux", windowsTerminal: false, kitty: false };
  assert.match(desktopRequest("task_done", { ...env, kitty: true }).sequence, /99;/);
  assert.match(desktopRequest("loop_approval", { ...env, termProgram: "WezTerm" }).sequence, /777;notify;Pi;/);
  assert.throws(() => desktopRequest("task_done", env), /No supported/);
  assert.throws(() => desktopRequest("untrusted text", env), /Unknown/);
});
