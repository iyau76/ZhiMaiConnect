import { describe, expect, it } from "vitest";

import { faceEngineFailurePolicy, shouldAttemptFaceEngineLoad } from "./face-engine-session";

describe("face engine session failure policy", () => {
  it("opens the circuit for automatic scans after model preparation failed", () => {
    expect(shouldAttemptFaceEngineLoad("error", "auto")).toBe(false);
    expect(faceEngineFailurePolicy({ autoEnabled: true, failureAlreadyReported: false })).toEqual({
      disableAuto: true,
      notify: true,
    });
  });

  it("does not repeat the same toast but still permits an explicit manual retry", () => {
    expect(faceEngineFailurePolicy({ autoEnabled: false, failureAlreadyReported: true })).toEqual({
      disableAuto: false,
      notify: false,
    });
    expect(shouldAttemptFaceEngineLoad("error", "manual")).toBe(true);
  });
});
