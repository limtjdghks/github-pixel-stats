import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
  assertObjectPathname,
  assertObjectPrefix,
  type ObjectEntry,
  type ObjectStore,
  type StoreAccess,
  type StoredObject,
  type WriteOptions,
} from "./object-store.js";

/** pathname segment는 `.`으로 시작할 수 없으므로 임시 파일 디렉터리와 겹치지 않습니다. */
const TEMP_DIRECTORY = ".tmp";

function etagOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * CLI·로컬 검증용 filesystem adapter입니다.
 * 조건부 쓰기는 같은 인스턴스 안에서만 직렬화되므로 여러 프로세스가 같은 root를 공유하면 안 됩니다.
 * ETag는 내용 hash이므로 같은 내용으로 되돌아온 객체는 이전과 같은 ETag를 가집니다.
 * cache TTL은 filesystem에 의미가 없어 무시합니다.
 */
export class FilesystemObjectStore implements ObjectStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string, readonly access: StoreAccess) {}

  private path(pathname: string): string {
    assertObjectPathname(pathname);
    return join(this.root, ...pathname.split("/"));
  }

  private async withLock<T>(pathname: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(pathname) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.catch(() => undefined);
    this.locks.set(pathname, settled);
    try {
      return await next;
    } finally {
      if (this.locks.get(pathname) === settled) this.locks.delete(pathname);
    }
  }

  async read(pathname: string, signal?: AbortSignal): Promise<StoredObject | null> {
    signal?.throwIfAborted();
    try {
      const body = await readFile(this.path(pathname), "utf8");
      return { body, etag: etagOf(body) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async write(pathname: string, body: string, options: WriteOptions): Promise<string | null> {
    const target = this.path(pathname);
    return this.withLock(pathname, async () => {
      options.signal?.throwIfAborted();
      const current = await this.read(pathname);
      const { condition } = options;
      if (
        (condition.kind === "absent" && current !== null) ||
        (condition.kind === "match" && current?.etag !== condition.etag)
      ) {
        return null;
      }
      const temporary = join(this.root, TEMP_DIRECTORY, randomUUID());
      await mkdir(dirname(temporary), { recursive: true });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporary, body);
      await rename(temporary, target);
      return etagOf(body);
    });
  }

  async list(prefix: string): Promise<ObjectEntry[]> {
    assertObjectPrefix(prefix);
    let names: string[];
    try {
      names = await readdir(this.root, { recursive: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const entries: ObjectEntry[] = [];
    for (const name of names) {
      const pathname = name.split(sep).join("/");
      if (!pathname.startsWith(prefix)) continue;
      const info = await stat(join(this.root, name));
      if (info.isFile()) {
        entries.push({ pathname, uploadedAt: info.mtime });
      }
    }
    return entries;
  }

  async delete(pathnames: readonly string[]): Promise<void> {
    await Promise.all(pathnames.map((pathname) => this.withLock(pathname, () => rm(this.path(pathname), { force: true }))));
  }
}
