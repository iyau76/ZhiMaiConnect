import {
  resolveSemanticRecordRef,
  type ArchiveRecordResolverSnapshot,
  type ResolvedRecordCandidate,
  type ResolvedRecordDomain,
} from "./archive-record-resolver";
import { SELF_PERSON_ID } from "./person-identity";

export interface ArchiveAgentReferenceSessionState {
  version: 1;
  namespace: string;
}

export interface ArchiveAgentVisibleReference {
  handle: string;
  label: string;
  domain: ResolvedRecordDomain;
}

export type ArchiveAgentReferenceResolution =
  | {
      status: "resolved";
      cardinality: "one" | "many";
      candidates: ArchiveAgentVisibleReference[];
    }
  | {
      status: "ambiguous";
      candidates: ArchiveAgentVisibleReference[];
      reason: string;
    }
  | {
      status: "missing";
      candidates: [];
      reason: string;
    };

export type ArchiveAgentHandleResolution =
  | {
      status: "resolved";
      domain: ResolvedRecordDomain;
      stableId: string;
    }
  | {
      status: "domain_mismatch";
      actualDomain: ResolvedRecordDomain;
      reason: string;
    }
  | {
      status: "missing";
      reason: string;
    };

interface IndexedReference {
  domain: ResolvedRecordDomain;
  stableId: string;
}

function digest128(value: string) {
  let h1 = 0x6a09e667;
  let h2 = 0xbb67ae85;
  let h3 = 0x3c6ef372;
  let h4 = 0xa54ff53a;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x239b961b);
    h2 = Math.imul(h2 ^ code, 0xab0e9789);
    h3 = Math.imul(h3 ^ code, 0x38b34ae5);
    h4 = Math.imul(h4 ^ code, 0xa1e38b93);
    const rotated = h1;
    h1 = h2 ^ (h1 >>> 13);
    h2 = h3 ^ (h2 >>> 11);
    h3 = h4 ^ (h3 >>> 17);
    h4 = rotated ^ (h4 >>> 19);
  }
  h1 = Math.imul(h1 ^ (h3 >>> 16), 0x85ebca6b);
  h2 = Math.imul(h2 ^ (h4 >>> 13), 0xc2b2ae35);
  h3 = Math.imul(h3 ^ (h1 >>> 16), 0x27d4eb2f);
  h4 = Math.imul(h4 ^ (h2 >>> 13), 0x165667b1);
  return [h1, h2, h3, h4].map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}

function referenceKey(domain: ResolvedRecordDomain, stableId: string) {
  return `${domain}\u0000${stableId}`;
}

function workspaceReferenceRows(snapshot: ArchiveRecordResolverSnapshot) {
  const workspace = snapshot.workspace;
  return [
    ...((workspace?.people ?? []).map((record) => ["person", record._draftId]) as Array<
      [ResolvedRecordDomain, string | undefined]
    >),
    ...((workspace?.facts ?? []).map((record) => ["fact", record._draftId]) as Array<
      [ResolvedRecordDomain, string | undefined]
    >),
    ...((workspace?.relations ?? []).map((record) => ["relation", record._draftId]) as Array<
      [ResolvedRecordDomain, string | undefined]
    >),
    ...((workspace?.events ?? []).map((record) => ["event", record._draftId]) as Array<
      [ResolvedRecordDomain, string | undefined]
    >),
    ...((workspace?.reminders ?? []).map((record) => ["reminder", record._draftId]) as Array<
      [ResolvedRecordDomain, string | undefined]
    >),
    ...((workspace?.evidence ?? []).map((record) => ["evidence", record._draftId]) as Array<
      [ResolvedRecordDomain, string | undefined]
    >),
  ].flatMap(([domain, stableId]) => (stableId ? [{ domain, stableId }] : []));
}

function snapshotReferences(snapshot: ArchiveRecordResolverSnapshot): IndexedReference[] {
  const references: IndexedReference[] = [
    ...snapshot.persons.map(({ id: stableId }) => ({ domain: "person" as const, stableId })),
    ...snapshot.relations.map(({ id: stableId }) => ({ domain: "relation" as const, stableId })),
    ...snapshot.events.map(({ id: stableId }) => ({ domain: "event" as const, stableId })),
    ...snapshot.collections.map(({ id: stableId }) => ({
      domain: "collection" as const,
      stableId,
    })),
    ...(snapshot.reminders ?? []).map(({ id: stableId }) => ({
      domain: "reminder" as const,
      stableId,
    })),
    ...(snapshot.evidence ?? []).map(({ id: stableId }) => ({
      domain: "evidence" as const,
      stableId,
    })),
    ...workspaceReferenceRows(snapshot),
    { domain: "person", stableId: SELF_PERSON_ID },
  ];
  return [
    ...new Map(references.map((item) => [referenceKey(item.domain, item.stableId), item])).values(),
  ].sort(
    (left, right) =>
      left.domain.localeCompare(right.domain) || left.stableId.localeCompare(right.stableId),
  );
}

/**
 * Run-scoped boundary between semantic selectors and stable archive IDs.
 * Handles are deterministic one-way digests, so model transcripts never need
 * to contain database identifiers and a resumed run can rebuild the same map.
 */
export class ArchiveAgentReferenceSession {
  readonly namespace: string;
  private readonly snapshot: ArchiveRecordResolverSnapshot;
  private readonly handleByReference = new Map<string, string>();
  private readonly referenceByHandle = new Map<string, IndexedReference>();

  constructor(snapshot: ArchiveRecordResolverSnapshot, namespace: string) {
    const normalizedNamespace = namespace.trim();
    if (!normalizedNamespace) throw new TypeError("Archive Agent reference namespace 不能为空");
    this.snapshot = snapshot;
    this.namespace = normalizedNamespace;
    for (const reference of snapshotReferences(snapshot)) {
      const key = referenceKey(reference.domain, reference.stableId);
      let salt = 0;
      let handle = this.handle(reference, salt);
      while (this.referenceByHandle.has(handle)) {
        salt += 1;
        handle = this.handle(reference, salt);
      }
      this.handleByReference.set(key, handle);
      this.referenceByHandle.set(handle, reference);
    }
  }

  static restore(
    snapshot: ArchiveRecordResolverSnapshot,
    state: ArchiveAgentReferenceSessionState,
  ) {
    if (state.version !== 1) throw new TypeError("不支持的 Archive Agent reference session 版本");
    return new ArchiveAgentReferenceSession(snapshot, state.namespace);
  }

  serialize(): ArchiveAgentReferenceSessionState {
    return { version: 1, namespace: this.namespace };
  }

  resolve(rawRef: unknown): ArchiveAgentReferenceResolution {
    const resolution = resolveSemanticRecordRef(rawRef, this.snapshot);
    if (resolution.status === "missing") {
      return { status: "missing", candidates: [], reason: resolution.reason };
    }
    const candidates = resolution.candidates.map((candidate) => this.visible(candidate));
    if (resolution.status === "ambiguous") {
      return { status: "ambiguous", candidates, reason: resolution.reason };
    }
    return { status: "resolved", cardinality: resolution.cardinality, candidates };
  }

  resolveMany(rawRefs: readonly unknown[]) {
    return rawRefs.map((rawRef) => this.resolve(rawRef));
  }

  reference(
    domain: ResolvedRecordDomain,
    stableId: string,
    label: string,
  ): ArchiveAgentVisibleReference {
    const handle = this.handleByReference.get(referenceKey(domain, stableId));
    if (!handle) throw new Error(`当前运行的 ${domain} 引用不存在`);
    return { handle, label, domain };
  }

  restoreHandle(
    handle: string,
    expectedDomain: ResolvedRecordDomain,
  ): ArchiveAgentHandleResolution {
    const reference = this.referenceByHandle.get(handle);
    if (!reference) return { status: "missing", reason: "当前运行中不存在该引用" };
    if (reference.domain !== expectedDomain) {
      return {
        status: "domain_mismatch",
        actualDomain: reference.domain,
        reason: `引用属于 ${reference.domain}，不能作为 ${expectedDomain} 使用`,
      };
    }
    return { status: "resolved", domain: reference.domain, stableId: reference.stableId };
  }

  private handle(reference: IndexedReference, salt: number) {
    return `ref_${digest128(
      `${this.namespace}\u0000${reference.domain}\u0000${reference.stableId}\u0000${salt}`,
    )}`;
  }

  private visible(candidate: ResolvedRecordCandidate): ArchiveAgentVisibleReference {
    const handle = this.handleByReference.get(referenceKey(candidate.domain, candidate.id));
    if (!handle) throw new Error("解析结果不在当前 Archive Agent reference snapshot 中");
    return { handle, label: candidate.label, domain: candidate.domain };
  }
}
