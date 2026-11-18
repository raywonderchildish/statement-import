import { File, UploadType } from 'expo-file-system';

import type { Http } from '../import';

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export const deviceHttp: Http = {
  request: ({ method, url, headers, timeoutMs }) =>
    withTimeout(timeoutMs, async signal => {
      const response = await fetch(url, { method, headers, signal });
      return { status: response.status, body: await response.text() };
    }),

  /**
   * The request body is streamed from the file by native code, so the bytes are
   * never base64-encoded or held in JS memory. A foreground session keeps the
   * outcome tied to this process: if the app dies, the engine recovers by key.
   */
  uploadFile: ({ url, headers, fileRef, timeoutMs }) =>
    withTimeout(timeoutMs, async signal => {
      const result = await new File(fileRef).upload(url, {
        httpMethod: 'POST',
        uploadType: UploadType.BINARY_CONTENT,
        headers,
        sessionType: 'foreground',
        signal,
      });
      return { status: result.status, body: result.body };
    }),
};
