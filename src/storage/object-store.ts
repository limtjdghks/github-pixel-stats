export type StoreAccess = "private" | "public";

export interface StoredObject {
  body: string;
  etag: string;
}

export interface ObjectEntry {
  pathname: string;
  uploadedAt: Date;
}

/**
 * 쓰기 전제조건입니다.
 * - `absent`: 객체가 없을 때만 생성합니다.
 * - `match`: 현재 ETag가 같을 때만 교체합니다.
 * - `content-addressed`: pathname에 내용 hash가 들어 있어 같은 pathname에는 항상 같은 내용만 쓰는 객체입니다.
 *   재시도로 같은 내용을 다시 쓰는 것을 허용하므로 변경 가능한 객체에는 사용하지 않습니다.
 */
export type WriteCondition =
  | { kind: "absent" }
  | { kind: "match"; etag: string }
  | { kind: "content-addressed" };

export interface WriteOptions {
  contentType: string;
  cacheControlMaxAge: number;
  condition: WriteCondition;
  signal?: AbortSignal;
}

/**
 * private 또는 public 중 한 가지 접근 방식으로 고정된 저장소의 최소 계약입니다.
 * filesystem, in-memory fake, Vercel Blob adapter가 같은 contract test를 통과해야 합니다.
 */
export interface ObjectStore {
  readonly access: StoreAccess;
  /** 객체가 없으면 null을 반환합니다. */
  read(pathname: string, signal?: AbortSignal): Promise<StoredObject | null>;
  /** 새 ETag를 반환하고, 전제조건이 맞지 않으면 아무것도 바꾸지 않고 null을 반환합니다. */
  write(pathname: string, body: string, options: WriteOptions): Promise<string | null>;
  /** prefix로 시작하는 모든 객체를 반환합니다. 반환 순서는 계약에 포함하지 않습니다. */
  list(prefix: string): Promise<ObjectEntry[]>;
  /** 없는 객체는 무시합니다. */
  delete(pathnames: readonly string[]): Promise<void>;
}

const PATHNAME_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

/** adapter 경계에서 경로 탈출·숨김 파일·빈 segment를 가진 pathname을 거부합니다. */
export function assertObjectPathname(pathname: string): void {
  const segments = pathname.split("/");
  if (segments.some((segment) => !PATHNAME_SEGMENT.test(segment) || segment.includes(".."))) {
    throw new Error("Invalid object pathname.");
  }
}

/** list prefix는 pathname 규칙을 따르는 디렉터리 형태(`a/b/`)만 허용합니다. */
export function assertObjectPrefix(prefix: string): void {
  if (!prefix.endsWith("/")) {
    throw new Error("Invalid object prefix.");
  }
  assertObjectPathname(prefix.slice(0, -1));
}
