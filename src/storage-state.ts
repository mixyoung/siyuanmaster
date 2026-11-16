import type * as kernel from "siyuan/kernel";

type StorageWait = <T>(action: () => Promise<T>) => Promise<T>;

/** SiYuan may decode stored JSON through Go maps, changing object-key order.
 * Compare JSON values; arrays and primitive types remain exact. */
export function equalStoredJson(actual: unknown, expected: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]),
    );
    return value;
  };
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

/** storage.list omits failed stat entries; readDir reports those failures instead. */
export async function confirmStorageFileMissing(
  api: Pick<kernel.ISiyuan, "client">,
  directory: string,
  key: string,
  wait: StorageWait = action => action(),
): Promise<boolean> {
  const response = await wait(() => api.client.fetch("/api/file/readDir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: `/${directory}` }),
  }));
  if (response.status !== 200) throw new Error(`Storage existence is unknown: ${key}`);
  const payload = JSON.parse(await wait(() => response.text())) as Record<string, unknown> | null;
  if (payload?.code === 404) return true;
  if (payload?.code !== 0 || !Array.isArray(payload.data) ||
    payload.data.some(entry => !entry || typeof entry.name !== "string" || !entry.name)) {
    throw new Error(`Storage existence is unknown: ${key}`);
  }
  return !payload.data.some(entry => entry.name === key);
}
