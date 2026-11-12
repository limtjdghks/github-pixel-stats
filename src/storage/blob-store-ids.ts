export interface BlobStoreIds {
  privateStoreId: string;
  publicStoreId: string;
}

/** SDK는 `store_` 접두사를 떼고 store를 식별하므로 `store_abc`와 `abc`는 같은 store입니다. */
export function isSameBlobStore(left: string, right: string): boolean {
  const normalize = (id: string) => {
    const trimmed = id.trim();
    return trimmed.startsWith("store_") ? trimmed.slice("store_".length) : trimmed;
  };
  return normalize(left) === normalize(right);
}
