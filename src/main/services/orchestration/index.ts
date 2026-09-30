// Public surface of the one-turn engine. Nothing here starts a process on import.
// startProviderTurn is the only public way to run a provider turn: it always checks the provider contract.
// The transport (turn.ts startTurn) is internal; its "completed" alone is not a verified provider turn.
export type {
  AnswerSchema,
  OrchestrationProvider,
  SupervisorLaunch,
  SupervisorTimings,
  TurnLimits,
  TurnOutcome,
  TurnReport,
  TurnResult
} from "./types.ts";
export { DEFAULT_TURN_LIMITS } from "./turn.ts";
export { SUPPORTED_SCHEMA_KEYWORDS, UnsupportedSchemaError, compileSchema, validateAnswer } from "./schema.ts";
export { ORCHESTRATION_PLATFORMS, resolveSupervisorLaunch } from "./supervisorLaunch.ts";
export type { SupervisorLaunchResolution } from "./supervisorLaunch.ts";
export { CLAUDE_EDIT_EXPECTED_INIT, CLAUDE_EXPECTED_INIT, PROVIDER_MODES, parseCliVersion, startProviderTurn } from "./providers.ts";
export type {
  ProviderContractCheck,
  ProviderMode,
  ProviderModeSupport,
  ProviderRefusal,
  ProviderSession,
  ProviderTurnInput,
  ProviderTurnResult,
  ProviderTurnStart
} from "./providers.ts";
// Run journal (source of truth) and recovery from it. Starts no process; not wired into application start yet.
export { StoreError, createRun, deleteRun, openRun, readRun, readText } from "./store.ts";
export type { CommandCheck, CreateRunOptions, OpenRunOptions, RunReadResult, RunWriter, StoreErrorCode, TurnIntentInput } from "./store.ts";
export type { CommandState, JournalIntegrity, PausedReason, RunState, RunStatus, TextRef, TurnState } from "./journal.ts";
// Managed copy, baseline, snapshots and checkpoints (stage-3-contract.md). Git primitives stay internal: they do not
// verify the workspace themselves. Every function returns its Git result first; the caller records the Store event.
export { WorkspaceError, clearIncompleteRestore, createWorkspace, openWorkspace, readIncompleteRestore, verifyWorkspace } from "./workspace.ts";
export type { RestoreIntent, SnapshotInfo, Workspace, WorkspaceErrorCode } from "./workspace.ts";
export { SnapshotError, applyRestore, createCheckpoint, createSnapshot, inspectWorkspaceRefs, matchesCheckpointIntent, prepareRestore } from "./snapshots.ts";
export type { CheckpointResult, PreparedRestore, SnapshotErrorCode, SnapshotResult } from "./snapshots.ts";
export type { WorkspaceFailedRestore, WorkspaceRestore, WorkspaceSnapshot, WorkspaceState } from "./journal.ts";
// Project checks in the managed copy (stage-4-contract.md). The registry is trusted configuration; an agent may only
// name an id from it. Nothing here starts a process on import.
export { CheckConfigError, MAX_CHECK_OUTPUT_BYTES, checkPreparedDeps, commandSha256, createRegistry, resolveCheck } from "./checks.ts";
export type { CheckCommand, CheckConfigErrorCode, CheckRegistry, PreparedDeps } from "./checks.ts";
export { EVIDENCE_NOT_COVERED, evidenceFingerprint } from "./evidence.ts";
export type { EvidenceFacts } from "./evidence.ts";
export type { CheckState, CheckStatus, NotVerifiedReason } from "./journal.ts";
export type { CheckFinishedInput, CheckStartedInput } from "./store.ts";
export { SANDBOX_EXEC, buildProfile, runSelftest, sandboxSupport } from "./sandbox.ts";
export type { SandboxPaths, SelftestResult } from "./sandbox.ts";
export { decideCheck, startCheck } from "./checkRunner.ts";
export type { CheckResult, SandboxApi } from "./checkRunner.ts";
export { runProjectCheck } from "./checkService.ts";
export type { ProjectCheckResult, RunProjectCheckOptions } from "./checkService.ts";
export { currentExecutableSha256, inspectPreparedDeps, startProjectCheck } from "./checkService.ts";
// Orchestration cycle (stage-5-contract.md): the state machine over the journal, the stable state keys and the agent
// port. Not wired into application start, UI or IPC; the provider adapter refuses an executor (no proven mode).
export { OrchestrationError, REPORT_SCHEMAS, createOrchestrationService } from "./orchestrationService.ts";
export type { CommandOutcome, GoalInput, OrchestrationDeps, RunCommand, RunHandle, RunView } from "./orchestrationService.ts";
export { DEFAULT_LIMITS, effectiveLimits, nextAction } from "./cycle.ts";
export type { Action, Goal, LimitKind, RunLimits, Snapshot } from "./cycle.ts";
export { checkKey, detectLoop, findingsKey, runKey } from "./progress.ts";
export { createProviderAgents, failedTurnResult } from "./agents.ts";
export type { AgentAdapter, AgentPrepared, AgentRole, AgentTurn, AgentTurnRequest, ProviderAgentsConfig, TurnPurpose } from "./agents.ts";
export type { OrchState } from "./journal.ts";
