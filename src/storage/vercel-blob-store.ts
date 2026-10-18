import {
  BlobPreconditionFailedError,
  del,
  get,
  list,
  put,
  type GetBlobResult,
  type GetCommandOptions,
  type ListBlobResult,
  type ListCommandOptions,
  type PutBlobResult,
  type PutCommandOptions,
} from "@vercel/blob";
import { getVercelOidcToken } from "@vercel/oidc";
import {
  assertObjectPathname,
  assertObjectPrefix,
  type ObjectEntry,
  type ObjectStore,
  type StoreAccess,
  type StoredObject,
  type WriteOptions,
} from "./object-store.js";
import type { BlobStoreIds } from "./blob-store-ids.js";

interface BlobCredentials {
  oidcToken: string;
  storeId: string;
  abortSignal?: AbortSignal;
}

/** adapter가 사용하는 `@vercel/blob` 함수만 모은 경계입니다. 테스트는 이 경계에 fake를 주입합니다. */
export interface BlobSdk {
  get(pathname: string, options: GetCommandOptions): Promise<GetBlobResult | null>;
  put(pathname: string, body: string, options: PutCommandOptions): Promise<PutBlobResult>;
  list(options: ListCommandOptions): Promise<ListBlobResult>;
  del(pathnames: string[], options: BlobCredentials): Promise<void>;
}

const defaultSdk: BlobSdk = { get, put, list, del };
const DELETE_BATCH_SIZE = 100;

export interface VercelBlobStoreOptions {
  access: StoreAccess;
  storeId: string;
  /** 기본값은 실행 중인 Vercel Function의 OIDC token입니다. */
  getOidcToken?: () => Promise<string>;
  sdk?: BlobSdk;
}

/**
 * 하나의 Vercel Blob store에 대한 adapter입니다.
 * 모든 요청에 OIDC token과 store ID를 명시해, SDK가 환경 변수의 다른 store 토큰으로 넘어가지 않게 합니다.
 * store의 private/public 접근 방식은 생성 후 바뀌지 않으므로 `access`는 실제 store와 같아야 합니다.
 */
export class VercelBlobObjectStore implements ObjectStore {
  readonly access: StoreAccess;
  private readonly storeId: string;
  private readonly getOidcToken: () => Promise<string>;
  private readonly sdk: BlobSdk;

  constructor(options: VercelBlobStoreOptions) {
    if (options.storeId.trim().length === 0) {
      throw new Error("Blob store ID is required.");
    }
    this.access = options.access;
    this.storeId = options.storeId.trim();
    this.getOidcToken = options.getOidcToken ?? getVercelOidcToken;
    this.sdk = options.sdk ?? defaultSdk;
  }

  private async credentials(signal?: AbortSignal): Promise<BlobCredentials> {
    const oidcToken = (await this.getOidcToken()).trim();
    if (oidcToken.length === 0) {
      throw new Error("Vercel OIDC token is unavailable.");
    }
    return signal === undefined
      ? { oidcToken, storeId: this.storeId }
      : { oidcToken, storeId: this.storeId, abortSignal: signal };
  }

  async read(pathname: string, signal?: AbortSignal): Promise<StoredObject | null> {
    assertObjectPathname(pathname);
    // manifest·checkpoint 조건부 갱신이 오래된 ETag를 읽지 않도록 CDN cache를 거치지 않습니다.
    const result = await this.sdk.get(pathname, { access: this.access, useCache: false, ...await this.credentials(signal) });
    if (result === null) return null;
    if (result.statusCode !== 200) {
      throw new Error("Unexpected Blob read status.");
    }
    return { body: await new Response(result.stream).text(), etag: result.blob.etag };
  }

  async write(pathname: string, body: string, options: WriteOptions): Promise<string | null> {
    assertObjectPathname(pathname);
    const credentials = await this.credentials(options.signal);
    const base = {
      access: this.access,
      addRandomSuffix: false,
      contentType: options.contentType,
      cacheControlMaxAge: options.cacheControlMaxAge,
      ...credentials,
    };
    const { condition } = options;
    try {
      const result = await this.sdk.put(pathname, body, condition.kind === "match"
        ? { ...base, ifMatch: condition.etag }
        : { ...base, allowOverwrite: condition.kind === "content-addressed" });
      return result.etag;
    } catch (error) {
      const precondition = error instanceof BlobPreconditionFailedError;
      if (!precondition && condition.kind !== "absent") throw error;
      // SDK는 이미 존재하는 객체 생성을 별도 오류 타입으로 구분하지 않습니다. 또 응답이 유실된 PUT을
      // 자동 재시도하면 실제로 반영된 쓰기도 충돌로 끝납니다. 그래서 현재 객체를 다시 읽어
      // 방금 쓴 내용이면 성공, 다른 내용이면 충돌, 객체가 없으면 원래 오류로 판정합니다.
      const current = await this.read(pathname, options.signal);
      if (current === null) {
        if (precondition) return null;
        throw error;
      }
      return current.body === body ? current.etag : null;
    }
  }

  async list(prefix: string): Promise<ObjectEntry[]> {
    assertObjectPrefix(prefix);
    const credentials = await this.credentials();
    const entries: ObjectEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sdk.list({ prefix, ...credentials, ...(cursor === undefined ? {} : { cursor }) });
      entries.push(...page.blobs.map((blob) => ({ pathname: blob.pathname, uploadedAt: blob.uploadedAt })));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
    return entries;
  }

  async delete(pathnames: readonly string[]): Promise<void> {
    pathnames.forEach(assertObjectPathname);
    if (pathnames.length === 0) return;
    const credentials = await this.credentials();
    for (let index = 0; index < pathnames.length; index += DELETE_BATCH_SIZE) {
      await this.sdk.del(pathnames.slice(index, index + DELETE_BATCH_SIZE), credentials);
    }
  }
}

/** 상태용 private store와 카드용 public store adapter를 함께 만듭니다. */
export function createVercelBlobStores(ids: BlobStoreIds): { privateStore: ObjectStore; publicStore: ObjectStore } {
  return {
    privateStore: new VercelBlobObjectStore({ access: "private", storeId: ids.privateStoreId }),
    publicStore: new VercelBlobObjectStore({ access: "public", storeId: ids.publicStoreId }),
  };
}
