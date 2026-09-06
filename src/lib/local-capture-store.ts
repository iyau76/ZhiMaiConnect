/** Unprocessed input only. Shared by the page and the service worker; no archive writes. */
export interface LocalCapture {
  id: string;
  createdAt: number;
  title: string;
  text: string;
  files: File[];
}

export const CAPTURE_DB = "zhimai-local-captures";
const STORE = "inbox";
export const CAPTURE_LIMITS = { files: 4, fileBytes: 12 * 1024 * 1024, textCharacters: 100_000 };

export function validateCapture(input: Pick<LocalCapture, "text" | "files">) {
  if (!input.text.trim() && !input.files.length) throw new Error("没有收到文字或文件");
  if (input.text.length > CAPTURE_LIMITS.textCharacters) throw new Error("文字过长，请分次分享");
  if (input.files.length > CAPTURE_LIMITS.files) throw new Error("一次最多接收 4 个文件");
  if (input.files.some((file) => file.size > CAPTURE_LIMITS.fileBytes)) {
    throw new Error("单个文件不能超过 12 MB");
  }
}

async function openCaptureDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CAPTURE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await openCaptureDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error("本机材料保存失败"));
      tx.onerror = () => reject(tx.error ?? request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveCapture(input: Omit<LocalCapture, "id" | "createdAt">) {
  validateCapture(input);
  const capture: LocalCapture = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
  await transact("readwrite", (store) => store.add(capture));
  return capture;
}

export async function listCaptures(): Promise<LocalCapture[]> {
  const records = await transact("readonly", (store) => store.getAll());
  return (records as LocalCapture[]).sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeCapture(id: string) {
  await transact("readwrite", (store) => store.delete(id));
}

export function captureText(title: string, text: string, url: string) {
  return [...new Set([title, text, url].map((part) => part.trim()).filter(Boolean))].join("\n\n");
}
