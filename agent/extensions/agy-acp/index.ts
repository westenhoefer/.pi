import { createAssistantMessageEventStream, type Provider, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgyModel, PROVIDER_ID, fallbackModels } from "./agy-models.ts";
import { agyLaunch } from "./launch.ts";
import { AgyRuntime, selectedTools } from "./runtime.ts";
import { PiOutput } from "./turn.ts";

export default function (pi: ExtensionAPI) {
  const runtime = new AgyRuntime(() => agyLaunch());
  const allow = new Set((process.env.PI_AGY_ACP_TOOLS ?? "").split(",").map(name => name.trim()).filter(Boolean));
  let models = fallbackModels;
  let session: ExtensionContext | undefined;

  const stream = (model: AgyModel, transcript: TranscriptContext, opts: SimpleStreamOptions = {}) => {
    const events = createAssistantMessageEventStream();
    const output = new PiOutput(events, model);
    const ctx = session;
    if (!ctx || ctx.mode !== "tui" || opts.sessionId !== ctx.sessionManager.getSessionId() || opts.disableContinuation || !ctx.isProjectTrusted()) {
      output.fail("error", "Antigravity's native harness is available only in the current interactive Pi session in a trusted workspace.");
    } else if (opts.toolChoice === "none") {
      output.fail("error", "Antigravity's native harness cannot be used for an explicitly tool-free request.");
    } else {
      void runtime.run(model, transcript, opts, ctx, selectedTools(transcript, allow, pi.getActiveTools()), output);
    }
    return events;
  };

  const source = "Antigravity CLI launcher (credentials managed outside Pi)";
  const provider: Provider<"agy-acp-v1"> = {
    id: PROVIDER_ID,
    name: "Antigravity (native ACP)",
    auth: { apiKey: {
      name: source,
      async check() { return { type: "api_key", source }; },
      async resolve() { return { auth: {}, source }; },
    } },
    getModels: () => models,
    // No ACP startup, auth, or network work during Pi startup or passive catalog refresh.
    async refreshModels(ctx) {
      if (!ctx.allowNetwork || !ctx.force || !session || session.mode !== "tui" || !session.isProjectTrusted()) return;
      const discovered = await runtime.discover(session.cwd, ctx.signal);
      await ctx.publish({ update: () => { models = discovered; } });
    },
    stream: (model, context, opts) => stream(model, context, opts),
    streamSimple: stream,
  };
  pi.registerProvider(provider);

  pi.on("session_start", (_event, ctx) => { session = ctx; });
  pi.on("before_agent_start", (_event, ctx) => { session = ctx; });
  pi.on("session_shutdown", async () => { session = undefined; await runtime.reset(); });
  pi.on("session_tree", () => runtime.reset());
  pi.on("session_compact", () => runtime.reset());
  pi.on("agent_settled", () => runtime.settle());
  pi.on("model_select", (event) => {
    if (event.previousModel?.provider === PROVIDER_ID && event.previousModel.id !== event.model.id || event.model.provider !== PROVIDER_ID) return runtime.reset();
  });
  // Pi's side summaries expect a model-only call. Never run those in an agent with native tools.
  pi.on("session_before_compact", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    if (event.reason !== "threshold") ctx.ui.notify("Switch to a model-only provider before compacting this Pi session.", "warning");
    return { cancel: true };
  });
  pi.on("session_before_tree", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID || !event.preparation.userWantsSummary) return;
    ctx.ui.notify("Switch to a model-only provider before generating a branch summary, or navigate without a summary.", "warning");
    return { cancel: true };
  });

  pi.registerCommand("agy-acp", {
    description: "Antigravity native ACP: status, refresh catalog, or reset session",
    getArgumentCompletions: prefix => ["status", "refresh", "reset"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      const command = args.trim() || "status";
      if (command === "status") {
        try { agyLaunch(); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Antigravity launcher unavailable.", "error"); return; }
        const active = pi.getActiveTools().filter(name => allow.has(name));
        ctx.ui.notify(`Antigravity · native tools enabled · ${runtime.running ? "session active" : "not started"}\nPi tool allowlist (active): ${active.join(", ") || "none"}`, "info");
      } else if (command === "reset") {
        await runtime.reset();
        ctx.ui.notify("Antigravity session closed.", "info");
      } else if (command === "refresh") {
        if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
          ctx.ui.notify("Refresh requires an interactive Pi session in a trusted workspace.", "warning");
          return;
        }
        if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current turn before refreshing Antigravity models.", "warning"); return; }
        session = ctx;
        const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true, allowNetwork: true });
        const error = result.errors.get(PROVIDER_ID);
        if (error) ctx.ui.notify(error.message, "error");
        else if (!result.aborted) ctx.ui.notify(`Antigravity catalog: ${models.length} model(s). Use /model to select one.`, "info");
      } else ctx.ui.notify("Usage: /agy-acp [status|refresh|reset]", "warning");
    },
  });
}
