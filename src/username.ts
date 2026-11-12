const USERNAME_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function parseUsername(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("GitHub username must be a string.");
  }
  const username = raw.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("GitHub username must be 1-39 letters, digits, or single internal hyphens.");
  }
  return username;
}

export function usernamesEqual(left: string, right: string): boolean {
  return parseUsername(left).toLowerCase() === parseUsername(right).toLowerCase();
}
