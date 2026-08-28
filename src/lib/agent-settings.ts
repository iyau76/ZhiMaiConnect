import { z } from "zod";

import {
  AGENT_BUDGET_PRESETS,
  agentBudgetSchema,
  resolveAgentBudget,
  type AgentBudget,
  type AgentBudgetPreset,
} from "./agent-runtime";
import { resolveAgentStorage, type AgentKeyValueStorage } from "./agent-run-store";

export const agentBudgetPresetSchema = z.enum(["quick", "standard", "deep"]);

export const agentSettingsSchema = z
  .object({
    version: z.literal(1),
    profile: z.union([agentBudgetPresetSchema, z.literal("custom")]),
    customBudget: agentBudgetSchema.optional(),
    savePrivatePayload: z.boolean().default(false),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.profile === "custom" && !settings.customBudget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customBudget"],
        message: "A custom profile requires a complete Agent budget",
      });
    }
  });

export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export interface AgentSettingsStoreOptions {
  storage?: AgentKeyValueStorage;
  storageKey?: string;
  now?: () => number;
}

export class AgentSettingsStoreError extends Error {}

const DEFAULT_STORAGE_KEY = "zhimai.agent-settings.v1";

function defaultAgentSettings(): AgentSettings {
  return { version: 1, profile: "standard", savePrivatePayload: false, updatedAt: 0 };
}

function cloneSettings(settings: AgentSettings) {
  return {
    ...settings,
    customBudget: settings.customBudget ? { ...settings.customBudget } : undefined,
  };
}

export class LocalAgentSettingsStore {
  private readonly storage: AgentKeyValueStorage;
  private readonly storageKey: string;
  private readonly now: () => number;

  constructor(options: AgentSettingsStoreOptions = {}) {
    this.storage = resolveAgentStorage(options.storage);
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.now = options.now ?? Date.now;
  }

  load(): AgentSettings {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (error) {
      throw new AgentSettingsStoreError(`Unable to read Agent settings: ${String(error)}`);
    }
    if (!raw) return defaultAgentSettings();
    try {
      const parsed = agentSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? cloneSettings(parsed.data) : defaultAgentSettings();
    } catch {
      return defaultAgentSettings();
    }
  }

  private persist(settings: AgentSettings) {
    const validated = agentSettingsSchema.parse(settings);
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(validated));
    } catch (error) {
      throw new AgentSettingsStoreError(`Unable to persist Agent settings: ${String(error)}`);
    }
    return cloneSettings(validated);
  }

  selectPreset(profile: AgentBudgetPreset) {
    const validatedProfile = agentBudgetPresetSchema.parse(profile);
    const previous = this.load();
    return this.persist({
      version: 1,
      profile: validatedProfile,
      customBudget: previous.customBudget,
      savePrivatePayload: previous.savePrivatePayload,
      updatedAt: this.now(),
    });
  }

  saveCustomBudget(budget: AgentBudget) {
    return this.persist({
      version: 1,
      profile: "custom",
      customBudget: agentBudgetSchema.parse(budget),
      savePrivatePayload: this.load().savePrivatePayload,
      updatedAt: this.now(),
    });
  }

  resolveBudget(settings = this.load()) {
    return settings.profile === "custom"
      ? resolveAgentBudget(settings.customBudget!)
      : resolveAgentBudget(settings.profile);
  }

  presets() {
    return {
      quick: { ...AGENT_BUDGET_PRESETS.quick },
      standard: { ...AGENT_BUDGET_PRESETS.standard },
      deep: { ...AGENT_BUDGET_PRESETS.deep },
    };
  }

  setSavePrivatePayload(enabled: boolean) {
    const previous = this.load();
    return this.persist({
      ...previous,
      savePrivatePayload: Boolean(enabled),
      updatedAt: this.now(),
    });
  }

  reset() {
    try {
      this.storage.removeItem(this.storageKey);
    } catch (error) {
      throw new AgentSettingsStoreError(`Unable to reset Agent settings: ${String(error)}`);
    }
    return defaultAgentSettings();
  }
}
