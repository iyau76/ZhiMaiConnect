/** 部门介绍：本地保存，key 为部门名 */
const KEY = "zhimai.department.notes";

type Store = Record<string, string>;

function read(): Store {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) || "{}") as Store;
  } catch {
    return {};
  }
}

export function getDepartmentNote(name: string): string {
  return read()[name] ?? "";
}

export function setDepartmentNote(name: string, note: string) {
  const store = read();
  if (note.trim()) store[name] = note.trim();
  else delete store[name];
  window.localStorage.setItem(KEY, JSON.stringify(store));
}

export function renameDepartmentNote(from: string, to: string) {
  const store = read();
  const note = store[from];
  if (!note) return;
  delete store[from];
  if (to.trim()) store[to.trim()] = note;
  window.localStorage.setItem(KEY, JSON.stringify(store));
}
