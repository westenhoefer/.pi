export type Dialect = "bash" | "powershell";
export interface DeleteTarget {
  value: string;
  recursive: boolean;
  dialect: Dialect | "python";
  uncertain?: boolean;
}
export interface CommandInspection {
  destructive: boolean;
  targets: DeleteTarget[];
  concerns: string[];
}
interface Word { value: string; dynamic: boolean; quoted: boolean }
interface Lexed { groups: Word[][]; compound: boolean; incomplete: boolean }

/** Deliberately a small lexer, not a shell interpreter. Never expands or executes input. */
function lex(source: string, dialect: Dialect): Lexed {
  const groups: Word[][] = [[]];
  let value = "", present = false, dynamic = false, quote = "", quoted = false;
  let compound = false;
  const flush = () => {
    if (present) groups[groups.length - 1].push({ value, dynamic, quoted });
    value = ""; present = false; dynamic = false; quoted = false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) {
        if (dialect === "powershell" && quote === "'" && source[i + 1] === "'") { value += "'"; i++; }
        else quote = "";
      } else if (quote === '"' && ((dialect === "bash" && c === "\\" && /[$`"\\\n]/.test(source[i + 1] ?? "")) || (dialect === "powershell" && c === "`"))) {
        // PowerShell backtick escapes and Bash line continuations are not interpreted here.
        if (dialect === "powershell" || source[i + 1] === "\n") dynamic = true;
        value += source[++i] ?? "";
      } else {
        if (quote === '"' && /[$`]/.test(c)) dynamic = true;
        value += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { present = true; quoted = true; quote = c; continue; }
    if (c === "#" && !present) {
      while (i < source.length && source[i] !== "\n") i++;
      i--; continue;
    }
    if (/[;|&\n]/.test(c)) {
      flush(); compound ||= c === "|" || c === "&"; groups.push([]); continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    present = true;
    if ((dialect === "bash" && c === "\\") || (dialect === "powershell" && c === "`")) {
      if (dialect === "powershell" || !source[i + 1] || source[i + 1] === "\n") dynamic = true;
      value += source[++i] ?? "";
      continue;
    }
    if (/[$`<>()[\]{}]/.test(c) || (dialect === "powershell" && c === ",")) dynamic = true;
    value += c;
  }
  flush();
  const nonempty = groups.filter((group) => group.length);
  return { groups: nonempty, compound: compound || nonempty.length > 1, incomplete: !!quote };
}

function executable(word: string): string {
  return word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
}
function empty(): CommandInspection { return { destructive: false, targets: [], concerns: [] }; }
function merge(into: CommandInspection, other: CommandInspection): void {
  into.destructive ||= other.destructive;
  into.targets.push(...other.targets);
  into.concerns.push(...other.concerns);
}

function inspectRemoval(words: Word[], dialect: Dialect): CommandInspection {
  const result = empty();
  result.destructive = true;
  const name = executable(words[0].value);
  const powershell = dialect === "powershell" || name === "remove-item" || name === "ri";
  const args = words.slice(1);
  let recursive = false, literalOnly = false;
  if (powershell && args.some((w) => !w.quoted && w.value.toLowerCase() === "-whatif")) return empty();
  // With POSIXLY_CORRECT, a help-looking token after an operand is a filename.
  if (!powershell && args.length === 1 && ["--help", "--version"].includes(args[0].value)) return empty();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], flag = arg.value.toLowerCase();
    if (!powershell && flag === "--" && !literalOnly) { literalOnly = true; continue; }
    if (!literalOnly && flag.startsWith("-") && (!powershell || !arg.quoted)) {
      if (powershell) {
        if (["-recurse", "-r"].includes(flag)) recursive = true;
        else if (["-path", "-literalpath", "-force", "-confirm", "-verbose"].includes(flag)) { /* value(s) collected below */ }
        else if (["-erroraction", "-warningaction"].includes(flag)) i++;
        else result.concerns.push(`Unrecognized Remove-Item option: ${arg.value}`);
      } else {
        if (flag === "--recursive" || /^-[rfdiv]+$/i.test(arg.value)) recursive ||= /r/i.test(arg.value);
        else if (["--force", "--verbose", "--dir", "--preserve-root", "--ignore-fail-on-non-empty"].includes(flag)) { /* no path effect */ }
        else result.concerns.push(`Deletion option needs review: ${arg.value}`);
      }
      if (arg.dynamic) result.concerns.push("Deletion options contain shell expansion.");
      continue;
    }
    result.targets.push({ value: arg.value, uncertain: arg.dynamic, recursive: false, dialect: powershell ? "powershell" : dialect });
  }
  for (const target of result.targets) target.recursive = recursive;
  if (!result.targets.length) result.concerns.push("Deletion has no statically resolvable target (possibly pipeline input).");
  return result;
}

interface PythonString { value: string; end: number; certain: boolean }
function pythonString(source: string, start: number): PythonString | undefined {
  let at = start, raw = false;
  if (/[rRuUbBfF]/.test(source[at] ?? "")) {
    const prefix = source[at++].toLowerCase();
    raw = prefix === "r";
    if (prefix !== "r" && prefix !== "u") return undefined;
  }
  const quote = source[at];
  if (quote !== "'" && quote !== '"') return undefined;
  if (source.slice(at, at + 3) === quote.repeat(3)) return undefined;
  let value = "", certain = true;
  for (at++; at < source.length; at++) {
    const c = source[at];
    if (c === quote) return { value, end: at + 1, certain };
    if (c === "\\") {
      const next = source[++at];
      if (next === undefined) return undefined;
      if (raw) value += `\\${next}`;
      else if (next === "\\" || next === "'" || next === '"') value += next;
      else { certain = false; value += `\\${next}`; }
    } else value += c;
  }
  return undefined;
}

/** Recognizes literal calls without evaluating Python or requiring an interpreter. */
function inspectPython(source: string): CommandInspection {
  const result = empty();
  // Mask strings/comments to avoid treating printed example code as executable deletion.
  const mask = source.split("");
  for (let i = 0; i < source.length; i++) {
    const literal = pythonString(source, i);
    if (literal) {
      for (let j = i; j < literal.end; j++) mask[j] = " ";
      i = literal.end - 1;
    } else if (source[i] === "#") {
      while (i < source.length && source[i] !== "\n") mask[i++] = " ";
      i--;
    }
  }
  const code = mask.join("");
  // Path('literal').unlink()/rmdir(), including pathlib.Path and keyword missing_ok.
  const handledMethods = new Set<number>();
  const pathCalls = /\b(?:pathlib\s*\.\s*)?Path\s*\(/g;
  for (const match of code.matchAll(pathCalls)) {
    const start = match.index! + match[0].length;
    const literalStart = start + (source.slice(start).match(/^\s*/)?.[0].length ?? 0);
    const literal = pythonString(source, literalStart);
    if (!literal) continue;
    const suffix = source.slice(literal.end).match(/^\s*\)\s*\.\s*(unlink|rmdir)\s*\(([^)]*)\)/);
    if (!suffix) continue;
    result.destructive = true;
    handledMethods.add(literal.end + suffix[0].indexOf(suffix[1]));
    const supportedOptions = /^\s*(?:missing_ok\s*=\s*(?:True|False)\s*,?\s*)?$/.test(suffix[2]);
    result.targets.push({ value: literal.value, dialect: "python", recursive: false, uncertain: !literal.certain || !supportedOptions });
  }
  const calls = /\b(?:(os|shutil)\s*\.\s*)?(remove|unlink|rmdir|rmtree|removedirs)\s*\(/g;
  for (const match of code.matchAll(calls)) {
    if (handledMethods.has(match.index!)) continue;
    result.destructive = true;
    if (match[2] === "removedirs" || (!match[1] && code.slice(0, match.index).trimEnd().endsWith("."))) {
      result.concerns.push("Python deletion uses an unresolved object/alias or removes parent directories.");
      continue;
    }
    const start = match.index! + match[0].length;
    const literalStart = start + (source.slice(start).match(/^\s*/)?.[0].length ?? 0);
    const literal = pythonString(source, literalStart);
    if (!literal || !/^\s*\)/.test(source.slice(literal.end))) {
      result.concerns.push(`Python ${match[2]} target or extra arguments are not a simple literal.`);
    } else result.targets.push({ value: literal.value, dialect: "python", recursive: match[2] === "rmtree", uncertain: !literal.certain });
  }
  if (result.destructive && /\b(?:chdir|chroot|dir_fd|exec|eval)\b/.test(code)) {
    result.concerns.push("Python changes path context or uses dynamic execution.");
  }
  return result;
}

function inspectWords(words: Word[], dialect: Dialect, depth: number): CommandInspection {
  if (!words.length) return empty();
  if (depth > 4) return { destructive: true, targets: [], concerns: ["Command wrappers are too deeply nested to inspect."] };
  if (dialect === "bash" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) {
    const next = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value));
    if (next < 0) return empty();
    const result = inspectWords(words.slice(next), dialect, depth + 1);
    if (result.destructive) result.concerns.push("Deletion uses inline environment assignments.");
    return result;
  }
  const name = executable(words[0].value);
  if (["then", "do", "else"].includes(name)) return inspectWords(words.slice(1), dialect, depth);
  if (["rm", "rmdir", "unlink", "remove-item", "ri", "del", "erase", "rd"].includes(name)) return inspectRemoval(words, dialect);
  const result = empty();
  const args = words.slice(1);
  if (["bash", "sh", "zsh", "powershell", "pwsh"].includes(name)) {
    const nestedDialect = name === "powershell" || name === "pwsh" ? "powershell" : "bash";
    if (args.some((w) => /^-(?:e|enc|encodedcommand)$/i.test(w.value))) {
      return { destructive: true, targets: [], concerns: ["Encoded shell commands cannot be inspected."] };
    }
    const codeIndex = args.findIndex((w) => nestedDialect === "powershell" ? /^-(?:command|c)$/i.test(w.value) : /^-[a-z]*c[a-z]*$/i.test(w.value));
    if (codeIndex < 0) return result;
    const payload = args.slice(codeIndex + 1);
    merge(result, inspectCommand(payload.map((w) => w.value).join(" "), nestedDialect, depth + 1));
    if (result.destructive && (payload.length !== 1 || payload[0]?.dynamic)) result.concerns.push("Nested shell command uses multiple arguments or expansion.");
    return result;
  }
  if (/^(?:python(?:\d+(?:\.\d+)*)?|py)$/.test(name)) {
    const codeIndex = args.findIndex((w) => w.value.startsWith("-c"));
    const option = args[codeIndex];
    const payload = option?.value === "-c" ? args[codeIndex + 1]
      : option ? { ...option, value: option.value.slice(2) } : undefined;
    if (payload) {
      merge(result, inspectPython(payload.value));
      if (result.destructive && payload.dynamic) result.concerns.push("Inline Python source contains shell expansion.");
    } else if (args.some((w) => w.value.includes("<<"))) {
      result.destructive = true;
      result.concerns.push("Python heredoc execution needs review; use a literal -c command for automatic path checks.");
    }
    return result;
  }
  if (["sudo", "command", "exec", "env", "xargs"].includes(name)) {
    const commandAt = args.findIndex((w) => /^(rm|rmdir|unlink|remove-item|ri|del|erase|rd|bash|sh|pwsh|powershell|python[\d.]*|py)$/.test(executable(w.value)));
    if (commandAt >= 0) {
      merge(result, inspectWords(args.slice(commandAt), dialect, depth + 1));
      if (result.destructive) result.concerns.push(`Deletion is wrapped by ${name}; review its arguments/input.`);
    }
    return result;
  }
  if (name === "eval") {
    merge(result, inspectCommand(args.map((w) => w.value).join(" "), dialect, depth + 1));
    if (result.destructive) result.concerns.push("Deletion uses eval.");
  }
  if (name === "find" && args.some((w) => w.value === "-delete" || w.value === "-exec" || w.value === "-execdir")) {
    result.destructive = true;
    result.concerns.push("find deletion/execution targets require review.");
  }
  const gitOptionsEnd = args.findIndex((word) => word.value === "--");
  const gitOptions = gitOptionsEnd < 0 ? args : args.slice(0, gitOptionsEnd);
  if (name === "git" && ((args.some((w) => w.value === "clean") && !gitOptions.some((w) => w.value === "--dry-run" || /^-[a-z]*n[a-z]*$/i.test(w.value))) || (args.some((w) => w.value === "reset") && args.some((w) => w.value === "--hard")))) {
    result.destructive = true;
    result.concerns.push("Destructive Git cleanup/reset requires confirmation.");
  }
  return result;
}

export function inspectCommand(source: string, dialect: Dialect = "bash", depth = 0): CommandInspection {
  if (depth > 4 || source.length > 32768) return { destructive: true, targets: [], concerns: ["Command is too large or deeply nested to inspect."] };
  const parsed = lex(source, dialect);
  const result = empty();
  for (const words of parsed.groups) merge(result, inspectWords(words, dialect, depth));
  if (result.destructive) {
    if (parsed.compound) result.concerns.push("Compound commands/pipelines may change the working directory or targets.");
    if (parsed.incomplete) result.concerns.push("Command contains an unterminated quote.");
    if (parsed.groups.some((words) => words.some((word) => word.dynamic))) result.concerns.push("Command contains expansion or syntax outside the supported literal subset.");
  }
  result.concerns = [...new Set(result.concerns)];
  return result;
}
