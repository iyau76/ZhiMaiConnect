// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderPreset } from "@/lib/vision-providers";

const coordinator = vi.hoisted(() => ({
  options: [] as unknown[],
  hydrate: vi.fn(),
  enqueue: vi.fn(),
  flushPersistence: vi.fn(),
  commit: vi.fn(),
  discard: vi.fn(),
  undo: vi.fn(),
}));

const artifactRepository = vi.hoisted(() => ({ kind: "indexed-db-mutation-artifacts" }));

const database = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listPersons: vi.fn(),
  listRelations: vi.fn(),
  listLifeEvents: vi.fn(),
}));

vi.mock("@/lib/agent-run-ledger", () => ({
  indexedDbMutationArtifactRepository: artifactRepository,
}));

vi.mock("@/lib/mutation-commit-coordinator", () => ({
  MutationCommitCoordinator: class {
    constructor(options: unknown) {
      coordinator.options.push(options);
    }

    hydrate = coordinator.hydrate;
    enqueue = coordinator.enqueue;
    flushPersistence = coordinator.flushPersistence;
    commit = coordinator.commit;
    discard = coordinator.discard;
    undo = coordinator.undo;
  },
}));

vi.mock("@/lib/face-db", () => ({ facesDb: database }));
vi.mock("@/lib/planning-agent", () => ({ runPlanningAgent: vi.fn() }));

import { PlanBoard } from "./plan-board";

const preset: ProviderPreset = {
  id: "provider",
  name: "Test",
  kind: "openai",
  baseUrl: "https://example.com/v1",
  model: "test-model",
  apiKey: "test-key",
};

const proposal = {
  id: "proposal:planning-1",
  enqueuedAt: 100,
  sourceRunId: "run-planning-1",
  scope: "planning",
  plan: {
    version: 1,
    id: "plan-planning-1",
    title: "行动计划：筹备展览",
    reason: "用户批准行动草案",
    createdAt: 100,
    operations: [
      {
        id: "operation-task-1",
        kind: "create_task",
        targetId: "task-1",
        reason: "用户批准此行动项",
        expectedRevision: null,
        replacement: {
          title: "确认展览场地",
          detail: "联系场地方",
          assignee: "林柚",
          personIds: ["person-lin"],
          priority: "high",
          due: "2026-09-08",
        },
      },
    ],
  },
};

const receipt = {
  id: "receipt:planning-1",
  operationIds: ["operation-task-1"],
  committedAt: 101,
};

beforeEach(() => {
  localStorage.clear();
  database.listTasks.mockResolvedValue([]);
  database.listPersons.mockResolvedValue([]);
  database.listRelations.mockResolvedValue([]);
  database.listLifeEvents.mockResolvedValue([]);
  coordinator.hydrate.mockResolvedValue({ proposals: [proposal], receipts: [receipt] });
  coordinator.flushPersistence.mockResolvedValue(undefined);
  coordinator.commit.mockResolvedValue(receipt);
  coordinator.undo.mockResolvedValue({ ...receipt, undoneAt: 102 });
  coordinator.discard.mockReturnValue([proposal]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PlanBoard mutation persistence", () => {
  it("uses the planning IndexedDB scope and restores approval and undo controls", async () => {
    render(<PlanBoard preset={preset} />);

    expect(coordinator.options[0]).toEqual({
      artifactRepository,
      scope: "planning",
    });
    expect(await screen.findByDisplayValue("确认展览场地")).toBeVisible();
    expect(screen.getByText(/本次批准已作为一个事务写入/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /批准并加入计划/ }));
    await waitFor(() =>
      expect(coordinator.commit).toHaveBeenCalledWith(
        expect.objectContaining({ proposalIds: ["proposal:planning-1"] }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "撤销本次批准" }));
    await waitFor(() => expect(coordinator.undo).toHaveBeenCalledWith("receipt:planning-1"));
  });

  it("settles rejection before removing a restored proposal from the page", async () => {
    render(<PlanBoard preset={preset} />);
    expect(await screen.findByDisplayValue("确认展览场地")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "放弃草案" }));

    await waitFor(() => {
      expect(coordinator.discard).toHaveBeenCalledWith(["proposal:planning-1"]);
      expect(coordinator.flushPersistence).toHaveBeenCalled();
      expect(screen.queryByDisplayValue("确认展览场地")).not.toBeInTheDocument();
    });
  });
});
