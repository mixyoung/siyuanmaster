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

/**
 * Read a workspace-relative JSON file via /api/file/getFile.
 * Fail closed: missing/corrupt/error → undefined. Never throws for migration.
 */
export function readWorkspaceJson(
  path: string,
): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    try {
      fetchPost("/api/file/getFile", { path }, (raw) => {
        try {
          const payload: unknown = raw;
          if (payload === null || payload === undefined) {
            resolve(undefined);
            return;
          }
          if (typeof payload === "string") {
            if (!payload) {
              resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(payload));
            } catch {
              resolve(undefined);
            }
            return;
          }
          if (typeof payload === "object") {
            const record = payload as Record<string, unknown>;
            if (
              "code" in record &&
              typeof record.code === "number" &&
              record.code !== 0
            ) {
              resolve(undefined);
              return;
            }
            resolve(payload);
            return;
          }
          resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
    } catch {
      resolve(undefined);
    }
  });
}
