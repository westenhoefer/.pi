import { isAbsolute, win32 } from "node:path";
import type { Launch } from "./acp.ts";

const ACP_ARGS = ["acp", "--stdio"];

function absoluteWindowsPath(path: string): boolean {
  // A single leading separator is relative to the current drive. Require a drive or UNC share.
  return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(path)
    && !/["<>|?*\x00-\x1f]/.test(path) && !path.slice(2).includes(":");
}

export function agyLaunch(env: NodeJS.ProcessEnv = process.env): Launch {
  const override = env.PI_AGY_ACP_COMMAND;
  if (process.platform !== "win32") {
    if (override !== undefined && (!isAbsolute(override) || override.includes("\0"))) {
      throw new Error("PI_AGY_ACP_COMMAND must be an absolute executable path.");
    }
    return { command: override ?? "agy", args: [...ACP_ARGS] };
  }

  let command: string;
  if (override !== undefined) {
    if (!absoluteWindowsPath(override) || /[\\/. ]$/.test(override)) {
      throw new Error("PI_AGY_ACP_COMMAND must be an absolute executable or batch-file path.");
    }
    command = override;
  } else {
    const home = env.USERPROFILE;
    if (!home || !absoluteWindowsPath(home)) {
      throw new Error("An absolute USERPROFILE is required to locate the Windows agy.cmd wrapper.");
    }
    command = win32.join(home, "bin", "agy.cmd");
  }
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args: [...ACP_ARGS] };
  command = command.replaceAll("/", "\\");

  // Quotes are already forbidden. In particular, quoted paths don't prevent %var% expansion.
  if (/[&()^%!]/.test(command)) throw new Error("The agy batch-file path contains unsafe cmd.exe characters.");
  const systemRoot = env.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  if (!absoluteWindowsPath(systemRoot)) throw new Error("An absolute SystemRoot is required to launch cmd.exe.");
  return {
    command: win32.join(systemRoot, "System32", "cmd.exe"),
    // /s removes the outer quotes, leaving the batch path quoted. The command tail
    // must reach cmd.exe verbatim, not with the usual Windows argv escaping.
    args: ["/d", "/s", "/v:off", "/c", `""${command}" acp --stdio"`],
    windowsVerbatimArguments: true,
  };
}
