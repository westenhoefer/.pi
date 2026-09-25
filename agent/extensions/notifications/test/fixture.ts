import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNotifications } from "../index.ts";

export default function notificationFixture(pi: ExtensionAPI): void {
  let fail = false;
  let deliveryGate: Promise<void> | undefined;
  pi.events.on("notifications:test-fail", () => { fail = true; });
  pi.events.on("notifications:test-gate", data => { deliveryGate = (data as { promise: Promise<void> }).promise; });
  registerNotifications(pi, async kind => {
    if (deliveryGate) await deliveryGate;
    if (fail) throw new Error("simulated delivery failure");
    pi.events.emit("notifications:test-delivered", kind);
  });
}
