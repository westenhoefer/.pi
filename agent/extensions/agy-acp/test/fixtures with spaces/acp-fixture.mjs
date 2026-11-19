import { once } from "node:events";
import { createInterface } from "node:readline";

const rpc = { jsonrpc: "2.0" };
const frame = message => JSON.stringify({ ...rpc, ...message }) + "\r\n";
const update = params => frame({ method: "session/update", params });
const send = message => process.stdout.write(frame(message));
const answer = (id, result) => send({ id, result });
const requests = [];
const replies = {};
let permissionRequest;
let lateRequest;

for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params, result, error } = JSON.parse(line);
  if (method) requests.push(method);
  switch (method) {
    case "frames": {
      const bytes = Buffer.from(update({ text: "雪🪁" }));
      const split = bytes.indexOf(Buffer.from("🪁")) + 2;
      process.stdout.write(bytes.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 30));
      process.stdout.write(Buffer.concat([bytes.subarray(split), Buffer.from(update({ text: "next" }) + frame({ id, result: params }))]));
      break;
    }
    case "permissions":
      permissionRequest = id;
      process.stdout.write(frame({ id: "grant", method: "session/request_permission", params: { allow: true } })
        + update({ text: "between" })
        + frame({ id: -41, method: "session/request_permission", params: { allow: false } })
        + frame({ id: "unsupported", method: "fs/write_text_file", params: {} }));
      break;
    case undefined:
      replies[id] = error ?? result;
      if (Object.keys(replies).length === 3) answer(permissionRequest, replies);
      break;
    case "session/cancel":
    case "hold":
      break;
    case "seen":
      answer(id, requests);
      break;
    case "late":
      lateRequest = id;
      break;
    case "flush":
      answer(lateRequest, "discarded response");
      answer(id, "current response");
      break;
    case "stay-alive":
      setTimeout(() => process.exit(0), 8000); // Bound the fixture's lifetime even if cleanup regresses.
      answer(id, process.pid);
      break;
    case "malformed":
      process.stdout.write("not JSON fixture-secret\n");
      break;
    case "invalid-utf8":
      process.stdout.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":"'),
        Buffer.from([0xc0, 0xaf]), Buffer.from('"}\n')]));
      break;
    case "overlong": {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let n = 0; n < 129; ++n) if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
      break;
    }
    case "invalid-envelope":
      send({ id, result: 1, error: { code: -32001, message: "fixture-secret" } });
      break;
    case "request-error":
      send({ id, error: { code: -32001, message: "fixture-secret", data: "fixture-secret" } });
      break;
    case "crash":
      process.stderr.write("fixture-secret\n", () => process.exit(7));
      break;
    case "final-frame":
      process.stdout.write(frame({ id, result: "last reply" }), () => process.exit(0));
      break;
    case "truncated":
      process.stdout.write('{"jsonrpc":"2.0","result":"fixture-secret', () => process.exit(7));
      break;
    default:
      answer(id, params);
  }
}
