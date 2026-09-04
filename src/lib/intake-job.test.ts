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

  it("restores a page projection without pretending that work is still running", async () => {
    const job = await import("./intake-job");
    job.restoreIntakeJob({
      trace: [{ kind: "status", text: "UNDERSTAND", at: 10 }],
      text: "source",
      extra: null,
    });

    expect(job.getIntakeJob()).toMatchObject({
      busy: false,
      text: "source",
      extra: null,
      result: null,
      error: null,
    });
    expect(job.getIntakeJob().trace).toEqual([{ kind: "status", text: "UNDERSTAND", at: 10 }]);
  });

  it("keeps the durable trace prefix when a suspended job resumes", async () => {
    const job = await import("./intake-job");
    job.startIntakeJob({
      text: "source",
      extra: null,
      initialTrace: "继续执行",
      priorTrace: [{ kind: "check", text: "已完成批次 1", at: 10 }],
      run: async () => "done",
    });

    await vi.waitFor(() => expect(job.getIntakeJob().busy).toBe(false));
    expect(job.getIntakeJob().trace.map((item) => item.text)).toEqual(["已完成批次 1", "继续执行"]);
  });
});
