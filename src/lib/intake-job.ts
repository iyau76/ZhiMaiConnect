/** 「AI 整理」跑在模块层，切到别的页签也不会中断；回到录入页再认领结果 */

export interface IntakeJobState {
  busy: boolean;
  /** 整理完但还没被界面认领的结果 */
  result: unknown | null;
  error: string | null;
  /** 本轮的补充材料（有值说明是「补充再整理」） */
  extra: string | null;
  /** 本轮送去整理的完整材料 */
  text: string | null;
}

const IDLE: IntakeJobState = { busy: false, result: null, error: null, extra: null, text: null };

let state: IntakeJobState = IDLE;
const listeners = new Set<() => void>();

function set(next: IntakeJobState) {
  state = next;
  listeners.forEach((fn) => fn());
}

export function getIntakeJob() {
  return state;
}

export function subscribeIntakeJob(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 界面拿走结果后清空，避免重复应用 */
export function claimIntakeJob() {
  if (state.result === null && state.error === null) return;
  set({ ...IDLE, busy: state.busy });
}

/** 启动一次整理；已经在跑就忽略 */
export function startIntakeJob(options: {
  text: string;
  extra: string | null;
  run: () => Promise<unknown>;
}) {
  if (state.busy) return;
  set({ busy: true, result: null, error: null, extra: options.extra, text: options.text });
  options
    .run()
    .then((result) => {
      set({ busy: false, result, error: null, extra: options.extra, text: options.text });
    })
    .catch((error: unknown) => {
      set({
        busy: false,
        result: null,
        error: (error as Error)?.message || "整理失败",
        extra: options.extra,
        text: options.text,
      });
    });
}
