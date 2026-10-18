import { BlobError, BlobPreconditionFailedError } from "@vercel/blob";
import type { BlobSdk } from "../../src/storage/vercel-blob-store.js";

interface FakeBlob {
  body: string;
  etag: string;
  uploadedAt: Date;
}

export interface RecordedCall {
  method: "get" | "put" | "list" | "del";
  options: Record<string, unknown>;
}

/**
 * 실제 Blob API 대신 `@vercel/blob`의 오류 타입과 조건부 쓰기 의미를 흉내 내는 fake입니다.
 * 이미 존재하는 객체 생성은 실제 SDK처럼 일반 `BlobError`로 실패시킵니다.
 * list는 cursor 처리를 검증하도록 2개씩 나눠 반환합니다.
 */
export class FakeBlobSdk implements BlobSdk {
  readonly blobs = new Map<string, FakeBlob>();
  readonly calls: RecordedCall[] = [];
  private sequence = 0;

  private record(method: RecordedCall["method"], options: object): void {
    this.calls.push({ method, options: { ...options } });
  }

  async get(pathname: string, options: Parameters<BlobSdk["get"]>[1]) {
    this.record("get", options);
    const blob = this.blobs.get(pathname);
    if (!blob) return null;
    return {
      statusCode: 200 as const,
      stream: new Response(blob.body).body!,
      headers: new Headers(),
      blob: {
        url: `https://fake.blob/${pathname}`, downloadUrl: `https://fake.blob/${pathname}?download=1`, pathname,
        contentDisposition: "inline", cacheControl: "max-age=60", uploadedAt: blob.uploadedAt, etag: blob.etag,
        contentType: "application/octet-stream", size: blob.body.length,
      },
    };
  }

  async put(pathname: string, body: string, options: Parameters<BlobSdk["put"]>[2]) {
    this.record("put", options);
    const current = this.blobs.get(pathname);
    if (options.ifMatch !== undefined) {
      if (current?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
    } else if (current && options.allowOverwrite !== true) {
      throw new BlobError("This blob already exists.");
    }
    const etag = `"b${++this.sequence}"`;
    this.blobs.set(pathname, { body, etag, uploadedAt: new Date() });
    return {
      url: `https://fake.blob/${pathname}`, downloadUrl: `https://fake.blob/${pathname}?download=1`, pathname,
      contentType: options.contentType ?? "application/octet-stream", contentDisposition: "inline", etag,
    };
  }

  async list(options: Parameters<BlobSdk["list"]>[0]) {
    this.record("list", options);
    const matches = [...this.blobs].filter(([pathname]) => pathname.startsWith(options.prefix ?? "")).sort(([a], [b]) => a.localeCompare(b));
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const page = matches.slice(start, start + 2);
    const hasMore = start + 2 < matches.length;
    return {
      blobs: page.map(([pathname, blob]) => ({
        url: `https://fake.blob/${pathname}`, downloadUrl: `https://fake.blob/${pathname}`, pathname,
        size: blob.body.length, uploadedAt: blob.uploadedAt, etag: blob.etag,
      })),
      hasMore,
      ...(hasMore ? { cursor: String(start + 2) } : {}),
    };
  }

  async del(pathnames: string[], options: Parameters<BlobSdk["del"]>[1]) {
    this.record("del", options);
    for (const pathname of pathnames) this.blobs.delete(pathname);
  }
}
