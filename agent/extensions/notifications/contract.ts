/** Session-local event bus contract. No task text crosses the desktop boundary. */
export const ATTENTION_EVENT = "pi:attention";
export type AttentionKind = "loop_approval" | "loop_done" | "loop_stopped" | "task_done" | "task_input" | "task_error" | "agent_update";
export interface AttentionRequest { sessionId: string; kind: AttentionKind }

export const ATTENTION_TEXT: Record<AttentionKind, string> = {
  agent_update: "Agent update. Review the latest progress in Pi.",
  loop_approval: "Iteration finished — approval required. Use /loop resume in Pi.",
  loop_done: "Loop completed. Review the result in Pi.",
  loop_stopped: "Loop stopped — review the status in Pi.",
  task_done: "Task finished. Review the result in Pi.",
  task_input: "Task needs your input. Return to Pi.",
  task_error: "Task interrupted or failed. Review the status in Pi.",
};
