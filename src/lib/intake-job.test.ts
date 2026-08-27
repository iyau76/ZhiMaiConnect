import { beforeEach, describe, expect, it, vi } from "vitest";

describe("intake background job trace", () => {
  beforeEach(() => vi.resetModules());

  it("streams user-facing stages and keeps the completed trace after the result is claimed", async () => {
    const job = await import("./intake-job");
    job.startIntakeJob({
      text: "测试材料",
      extra: null,
      initialTrace: "准备材料",
      run: async (report) => {
        report("梳理人物", "model");
        await Promise.resolve();
        report("核对证据", "check");
        report("整理完成", "done");
        return { people: [] };
      },
    });

    await vi.waitFor(() => expect(job.getIntakeJob().busy).toBe(false));
    expect(job.getIntakeJob().trace.map((item) => item.text)).toEqual([
      "准备材料",
      "梳理人物",
      "核对证据",
      "整理完成",
    ]);
    expect(job.getIntakeJob().result).toEqual({ people: [] });

    job.claimIntakeJob();
    expect(job.getIntakeJob().result).toBeNull();
    expect(job.getIntakeJob().trace.at(-1)?.text).toBe("整理完成");
  });

  it("records a safe error step when organising fails", async () => {
    const job = await import("./intake-job");
    job.startIntakeJob({
      text: "测试材料",
      extra: null,
      initialTrace: "准备材料",
      run: async () => {
        throw new Error("模型格式错误");
      },
    });

    await vi.waitFor(() => expect(job.getIntakeJob().busy).toBe(false));
    expect(job.getIntakeJob()).toMatchObject({ error: "模型格式错误" });
    expect(job.getIntakeJob().trace.at(-1)).toMatchObject({
      kind: "error",
      text: "模型格式错误",
    });
  });
});
