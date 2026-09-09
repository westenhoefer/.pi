import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCommand } from "../commands.ts";

const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
const python = (source, launcher = "python") => `${launcher} -c ${quote(source)}`;

for (const [command, dialect, values, recursive] of [
  ["rm -rf build", "bash", ["build"], true],
  ["rm -rf build\n", "bash", ["build"], true],
  ["/usr/bin/rm --recursive -- 'build output' second", "bash", ["build output", "second"], true],
  ["rm -- -odd-name", "bash", ["-odd-name"], false],
  ["rm -- --help ../outside", "bash", ["--help", "../outside"], false],
  ["Remove-Item -LiteralPath '-WhatIf' '../outside'", "powershell", ["-WhatIf", "../outside"], false],
  ["rmdir empty", "bash", ["empty"], false],
  ["unlink file.txt", "bash", ["file.txt"], false],
  ["Remove-Item -LiteralPath '.\\build output' -Recurse -Force", "powershell", [".\\build output"], true],
  ["ri -Path 'one' 'two' -ErrorAction Stop", "powershell", ["one", "two"], false],
  ["rm -Recurse -Force 'C:\\Users\\johan\\build'", "powershell", ["C:\\Users\\johan\\build"], true],
  ["del -LiteralPath 'file.txt'", "powershell", ["file.txt"], false],
  ["Remove-Item 'it''s old'", "powershell", ["it's old"], false],
  [python("import os; os.remove('file.txt')"), "bash", ["file.txt"], false],
  ['python -c"import os; os.remove(\'../outside/sentinel\')"', "bash", ["../outside/sentinel"], false],
  [python("import os; os.unlink('file.txt')", "python3.12"), "bash", ["file.txt"], false],
  [python("import os; os.rmdir('empty')", "py -3"), "bash", ["empty"], false],
  [python("import shutil; shutil.rmtree('../outside')"), "bash", ["../outside"], true],
  [python("from pathlib import Path; Path('file.txt').unlink(missing_ok=True)"), "bash", ["file.txt"], false],
  [python("import pathlib; pathlib.Path('empty').rmdir()"), "bash", ["empty"], false],
  [python("import shutil; shutil.rmtree(r'C:\\Users\\johan\\build')"), "bash", ["C:\\Users\\johan\\build"], true],
  ["bash -c 'rm -rf build'", "bash", ["build"], true],
  ["pwsh -NoProfile -Command 'Remove-Item -LiteralPath build -Recurse'", "bash", ["build"], true],
]) {
  test(`recognizes ${command}`, () => {
    const result = inspectCommand(command, dialect);
    assert.equal(result.destructive, true);
    assert.deepEqual(result.targets.map((target) => target.value), values);
    assert.ok(result.targets.every((target) => target.recursive === recursive));
    assert.deepEqual(result.concerns, []);
  });
}

for (const command of [
  "git status --short", "npm test", "echo 'rm -rf ../outside'", "grep -n 'Remove-Item' README.md",
  "rm --help", "git clean -ndxf", "git clean --dry-run -d", "python script.py",
  python('print("shutil.rmtree(\'outside\')")'),
  python("# os.remove('outside')\nprint('okay')"),
]) {
  test(`does not gate non-deletion: ${command}`, () => assert.equal(inspectCommand(command).destructive, false));
}
test("PowerShell -WhatIf remains a dry run", () => {
  assert.equal(inspectCommand("Remove-Item -WhatIf -Recurse ../outside", "powershell").destructive, false);
  assert.equal(inspectCommand("Remove-Item -WhatIf:$false -Recurse ../outside", "powershell").destructive, true);
});

for (const [command, dialect = "bash"] of [
  ["cd .. && rm -rf cache"], ["rm -rf one; rm -rf two"], ["rm -rf $TARGET"], ["rm 'unterminated"],
  ["TARGET=../outside rm -rf \"$TARGET\""], ["ENV=value rm -rf ../outside"],
  ["POSIXLY_CORRECT=1 rm -f ../outside/sentinel --help"],
  ["rm -f ../outside/sentinel --help"],
  ["rmdir -p nested/path"], ["rm --unknown value target"], ["sudo -u other rm -rf cache"],
  ["find . -name cache -delete"], ["find . -exec rm {} +"], ["printf x | xargs rm"],
  ["git reset --hard HEAD"], ["git clean -fdx"], ["git clean -fdx -- -n"], ["bash -c 'cd ..; rm -rf cache'"],
  ["if test -d build; then rm -rf build; fi"],
  ["pwsh -EncodedCommand AAAA"], ["pwsh -Command 'Set-Location ..; Remove-Item cache -Recurse'"],
  ["Get-ChildItem cache | Remove-Item -Recurse", "powershell"],
  ["Remove-Item -Path $env:TEMP -Recurse", "powershell"],
  ["Remove-Item 'build','/outside' -Recurse", "powershell"],
  [python("import shutil; shutil.rmtree(target)")],
  [python("import os; os.remove('file', dir_fd=fd)")],
  [python("from pathlib import Path; Path('safe').unlink(); other.unlink()")],
  [python("from pathlib import Path; other.unlink(); Path('safe').unlink()")],
  [python("import shutil as s; s.rmtree('path')")],
  [python("import os; os.removedirs('parent/child')")],
  [python("import os; os.chdir('..'); os.remove('path')")],
  ["python - <<'PY'\nimport shutil\nshutil.rmtree('outside')\nPY"],
]) {
  test(`requires review for ambiguous deletion: ${command}`, () => {
    const result = inspectCommand(command, dialect);
    assert.equal(result.destructive, true);
    assert.ok(result.concerns.length || result.targets.some((target) => target.uncertain), JSON.stringify(result));
  });
}

test("all Python literal deletion calls are collected, not just the first", () => {
  const result = inspectCommand(python("import os; from pathlib import Path; Path('a').unlink(); os.remove('../b'); os.unlink('c')"));
  assert.deepEqual(result.targets.map((t) => t.value).sort(), ["../b", "a", "c"]);
  assert.deepEqual(result.concerns, []);
});
