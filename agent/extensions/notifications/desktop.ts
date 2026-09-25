import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { ATTENTION_TEXT, type AttentionKind } from "./contract.ts";

export interface DesktopEnvironment {
  platform: string;
  windowsTerminal: boolean;
  kitty: boolean;
  termProgram?: string;
  term?: string;
}
export type DesktopRequest = { file: string; args: string[] } | { sequence: string };

/** Only fixed status messages are accepted, never model/user text or shell fragments. */
export function desktopRequest(kind: AttentionKind, env: DesktopEnvironment): DesktopRequest {
  const body = ATTENTION_TEXT[kind];
  if (!body) throw new Error("Unknown notification kind.");
  if (env.platform === "win32" || env.windowsTerminal) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$nodes = $xml.GetElementsByTagName('text')",
      "$title = $nodes.Item(0)",
      "$message = $nodes.Item(1)",
      "$null = $title.AppendChild($xml.CreateTextNode('Pi'))",
      `$null = $message.AppendChild($xml.CreateTextNode('${body.replaceAll("'", "''")}'))`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell').Show($toast)",
    ].join("; ");
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
  }
  if (env.kitty) return { sequence: `\x1b]99;i=pi-attention:d=0;Pi\x1b\\\x1b]99;i=pi-attention:p=body;${body}\x1b\\` };
  if (["ghostty", "iTerm.app", "WezTerm"].includes(env.termProgram ?? "") || env.term === "rxvt-unicode" || env.term === "rxvt-unicode-256color") {
    return { sequence: `\x1b]777;notify;Pi;${body}\x07` };
  }
  throw new Error("No supported desktop notification backend for this terminal.");
}

export function createDesktopNotifier(env: DesktopEnvironment): (kind: AttentionKind) => Promise<void> {
  const execute = promisify(execFile);
  return async kind => {
    const request = desktopRequest(kind, env);
    if ("sequence" in request) { process.stdout.write(request.sequence); return; }
    try {
      await execute(request.file, request.args, { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 });
    } catch (error) {
      const failure = error as Error & { code?: string | number; stderr?: string; killed?: boolean };
      const reason = failure.stderr?.trim() || failure.code || (failure.killed ? "timed out" : "could not launch PowerShell");
      // Do not leak command arguments or unchecked terminal controls into the UI.
      const detail = stripVTControlCharacters(String(reason)).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 400);
      throw new Error(`Windows toast failed: ${detail}`);
    }
  };
}
