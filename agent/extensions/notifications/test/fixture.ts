import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNotifications } from "../index.ts";

export default function notificationFixture(pi: ExtensionAPI): void {
  let fail = false;
  pi.events.on("notifications:test-fail", () => { fail = true; });
  registerNotifications(pi, async kind => {
    if (fail) throw new Error("simulated delivery failure");
    pi.events.emit("notifications:test-delivered", kind);
  });
}
