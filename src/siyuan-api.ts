import { fetchPost } from "siyuan";
import type { NotebookSummary } from "./types";

interface KernelResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

export function postKernel<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    fetchPost(path, body, (rawResponse) => {
      const response = rawResponse as KernelResponse<T>;
      if (response.code !== 0) {
        reject(new Error(response.msg || `SiYuan API failed: ${path}`));
        return;
      }
      resolve(response.data as T);
    });
  });
}

export async function listNotebooks(): Promise<NotebookSummary[]> {
  const data = await postKernel<{ notebooks?: NotebookSummary[] }>(
    "/api/notebook/lsNotebooks",
  );
  return [...(data.notebooks ?? [])].sort((a, b) => {
    const left = a.sort ?? Number.MAX_SAFE_INTEGER;
    const right = b.sort ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.name.localeCompare(b.name, "zh-CN");
  });
}
