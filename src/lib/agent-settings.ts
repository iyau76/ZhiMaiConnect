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
export const agentAuthorizationModeSchema = z.enum(["cautious", "standard", "full"]);
export type AgentAuthorizationMode = z.infer<typeof agentAuthorizationModeSchema>;

const agentSettingsV1Schema = z
  .object({
    version: z.literal(1),
    profile: z.union([agentBudgetPresetSchema, z.literal("custom")]),
    customBudget: agentBudgetSchema.optional(),
    savePrivatePayload: z.boolean().default(false),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const agentSettingsSchema = z
  .object({
    version: z.literal(2),
    profile: z.union([agentBudgetPresetSchema, z.literal("custom")]),
    customBudget: agentBudgetSchema.optional(),
    authorizationMode: agentAuthorizationModeSchema,
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

export function resolveAgentSettingsBudget(settings: AgentSettings) {
  return settings.profile === "custom"
    ? resolveAgentBudget(settings.customBudget!)
    : resolveAgentBudget(settings.profile);
}

export interface AgentSettingsStoreOptions {
  storage?: AgentKeyValueStorage;
  storageKey?: string;
  legacyStorageKey?: string;
  now?: () => number;
}

export class AgentSettingsStoreError extends Error {}

const DEFAULT_STORAGE_KEY = "zhimai.agent-settings.v2";
const LEGACY_STORAGE_KEY = "zhimai.agent-settings.v1";

function defaultAgentSettings(): AgentSettings {
  return {
    version: 2,
    profile: "standard",
    authorizationMode: "standard",
    savePrivatePayload: false,
    updatedAt: 0,
  };
}

function cloneSettings(settings: AgentSettings): AgentSettings {
  return {
    ...settings,
    customBudget: settings.customBudget ? { ...settings.customBudget } : undefined,
  };
}

export class LocalAgentSettingsStore {
  private readonly storage: AgentKeyValueStorage;
  private readonly storageKey: string;
  private readonly legacyStorageKey: string;
  private readonly now: () => number;

  constructor(options: AgentSettingsStoreOptions = {}) {
    this.storage = resolveAgentStorage(options.storage);
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.legacyStorageKey = options.legacyStorageKey ?? LEGACY_STORAGE_KEY;
    this.now = options.now ?? Date.now;
  }

  load(): AgentSettings {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (error) {
      throw new AgentSettingsStoreError(`Unable to read Agent settings: ${String(error)}`);
    }
    if (raw) {
      try {
        const parsed = agentSettingsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? cloneSettings(parsed.data) : defaultAgentSettings();
      } catch {
        return defaultAgentSettings();
      }
    }

    let legacyRaw: string | null;
    try {
      legacyRaw = this.storage.getItem(this.legacyStorageKey);
    } catch (error) {
      throw new AgentSettingsStoreError(`Unable to read Agent settings: ${String(error)}`);
    }
    if (!legacyRaw) return defaultAgentSettings();
    try {
      const legacy = agentSettingsV1Schema.parse(JSON.parse(legacyRaw));
      const saved = this.persist({
        ...legacy,
        version: 2,
        authorizationMode: "standard",
      });
      this.storage.removeItem(this.legacyStorageKey);
      return saved;
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
    const previous = this.load();
    return this.persist({
      ...previous,
      profile: agentBudgetPresetSchema.parse(profile),
      updatedAt: this.now(),
    });
  }

  saveCustomBudget(budget: AgentBudget) {
    return this.persist({
      ...this.load(),
      profile: "custom",
      customBudget: agentBudgetSchema.parse(budget),
      updatedAt: this.now(),
    });
  }

  resolveBudget(settings = this.load()) {
    return resolveAgentSettingsBudget(settings);
  }

  presets() {
    return {
      quick: { ...AGENT_BUDGET_PRESETS.quick },
      standard: { ...AGENT_BUDGET_PRESETS.standard },
      deep: { ...AGENT_BUDGET_PRESETS.deep },
    };
  }

  setAuthorizationMode(mode: AgentAuthorizationMode) {
    const previous = this.load();
    return this.persist({
      ...previous,
      authorizationMode: agentAuthorizationModeSchema.parse(mode),
      updatedAt: this.now(),
    });
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
      this.storage.removeItem(this.legacyStorageKey);
    } catch (error) {
      throw new AgentSettingsStoreError(`Unable to reset Agent settings: ${String(error)}`);
    }
    return defaultAgentSettings();
  }
}
