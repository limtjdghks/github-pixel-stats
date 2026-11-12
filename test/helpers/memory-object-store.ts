import {
  assertObjectPathname,
  assertObjectPrefix,
  type ObjectEntry,
  type ObjectStore,
  type StoreAccess,
  type StoredObject,
  type WriteOptions,
} from "../../src/storage/object-store.js";

interface MemoryObject {
  body: string;
  etag: string;
  uploadedAt: Date;
  contentType: string;
  cacheControlMaxAge: number;
}

/** 테스트용 in-memory adapter입니다. 업로드 시각은 주입한 clock을 따릅니다. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, MemoryObject>();
  private sequence = 0;

  constructor(readonly access: StoreAccess, private readonly now: () => Date = () => new Date()) {}

  async read(pathname: string, signal?: AbortSignal): Promise<StoredObject | null> {
    signal?.throwIfAborted();
    assertObjectPathname(pathname);
    const object = this.objects.get(pathname);
    return object ? { body: object.body, etag: object.etag } : null;
  }

  async write(pathname: string, body: string, options: WriteOptions): Promise<string | null> {
    options.signal?.throwIfAborted();
    assertObjectPathname(pathname);
    const current = this.objects.get(pathname);
    const { condition } = options;
    if ((condition.kind === "absent" && current) || (condition.kind === "match" && current?.etag !== condition.etag)) {
      return null;
    }
    const etag = `"m${++this.sequence}"`;
    this.objects.set(pathname, {
      body, etag, uploadedAt: this.now(), contentType: options.contentType, cacheControlMaxAge: options.cacheControlMaxAge,
    });
    return etag;
  }

  async list(prefix: string): Promise<ObjectEntry[]> {
    assertObjectPrefix(prefix);
    return [...this.objects]
      .filter(([pathname]) => pathname.startsWith(prefix))
      .map(([pathname, object]) => ({ pathname, uploadedAt: object.uploadedAt }));
  }

  async delete(pathnames: readonly string[]): Promise<void> {
    for (const pathname of pathnames) {
      assertObjectPathname(pathname);
      this.objects.delete(pathname);
    }
  }

  pathnames(): string[] {
    return [...this.objects.keys()].sort();
  }
}
