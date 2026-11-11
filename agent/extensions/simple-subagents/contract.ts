/** Process-local coordination only. This is not an authorization boundary against trusted extensions. */
export const START_QUERY = "simple-subagents:start-query:v1";
export const CHILD_STARTED = "simple-subagents:started:v1";
export const COMPLETION_TYPE = "simple-subagent-result";
export interface StartQuery { sessionId: string; allowed: boolean; reason?: string; loopId?: string; round?: number }
export interface ChildIdentity { sessionId: string; id: string; loopId?: string }
export type ChildStarted = ChildIdentity;
export interface CompletionDetails extends ChildIdentity { state: string }

export const RUN_REGISTER = "simple-subagents:run-register:v1";
export const RUN_QUERY = "simple-subagents:run-query:v1";
export const RUN_NOTICE = "simple-subagents:run-notice:v1";
export const RUN_REVOKED = "simple-subagents:run-revoked:v1";
export const SWARM_COMPLETION_TYPE = "simple-swarm-result";
// Observational only: lets the panel avoid a UI prompt that would revoke loop work.
export const LOOP_STATUS_QUERY = "goal-loop:status-query:v1";
export interface LoopStatusQuery { sessionId: string; active: boolean }
export interface RunIdentity { sessionId: string; id: string; loopId: string; round: number }
export interface RunClaim extends RunIdentity { allowed: boolean; reason?: string }
export interface RunRevoked { sessionId: string; loopId: string; round: number; reason: string }
export interface SwarmDelivery {
  sessionId: string; id: string; loopId?: string; round?: number; deliveryId: string; final: boolean;
}
