export type FaceEngineState = "idle" | "loading" | "ready" | "error";
export type FaceEngineTrigger = "manual" | "auto";

/** Auto mode is a scheduler, not an implicit infinite retry policy. */
export function shouldAttemptFaceEngineLoad(
  state: FaceEngineState,
  trigger: FaceEngineTrigger,
): boolean {
  if (state === "ready" || state === "loading") return false;
  return state !== "error" || trigger === "manual";
}

export function faceEngineFailurePolicy(input: {
  autoEnabled: boolean;
  failureAlreadyReported: boolean;
}) {
  return {
    disableAuto: input.autoEnabled,
    notify: !input.failureAlreadyReported,
  };
}
