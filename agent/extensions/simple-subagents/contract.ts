/** Process-local coordination only. This is not an authorization boundary against trusted extensions. */
export const START_QUERY = "simple-subagents:start-query:v1";
export const CHILD_STARTED = "simple-subagents:started:v1";
export const COMPLETION_TYPE = "simple-subagent-result";
export interface StartQuery { sessionId: string; allowed: boolean; reason?: string; loopId?: string }
export interface ChildIdentity { sessionId: string; id: string; loopId?: string }
export type ChildStarted = ChildIdentity;
export interface CompletionDetails extends ChildIdentity { state: string }
