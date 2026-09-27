import type { CollectionCheckpoint } from "./checkpoint-model.js";
import type { LanguageClassifier } from "./collection-ports.js";
import { assembleCollectionResult } from "./collection-model.js";
import { commitKey, splitSearchInterval, type PageRequest, type PageResult } from "./github-pages.js";

export function nextPageRequest(checkpoint: CollectionCheckpoint): PageRequest {
  const cursor = checkpoint.cursor;
  switch (cursor.stage) {
    case "profile":
      return { kind: "profile", username: checkpoint.username };
    case "repositories":
      return { kind: "repositories", username: checkpoint.username, page: cursor.page };
    case "search": {
      const range = cursor.current;
      if (!range) {
        throw new Error("Search cursor has no current interval.");
      }
      return { kind: "search", username: checkpoint.username, from: range.from, to: range.to, page: range.page };
    }
    case "details": {
      const commit = checkpoint.searched[cursor.index];
      if (!commit) {
        throw new Error("Detail cursor has no commit.");
      }
      return { kind: "files", repository: commit.repository, sha: commit.sha, page: cursor.page };
    }
    case "complete":
      throw new Error("Collection is already complete.");
  }
}

export function advanceWithoutRequest(checkpoint: CollectionCheckpoint, classifier: LanguageClassifier): boolean {
  const cursor = checkpoint.cursor;
  if (cursor.stage === "search" && !cursor.current) {
    const range = cursor.pending.shift();
    if (range) {
      cursor.current = { ...range, page: 1, totalCount: null, commits: [] };
    } else {
      checkpoint.searched = [...new Map(checkpoint.searched.map((commit) => [commitKey(commit), commit])).values()]
        .sort((left, right) => left.authoredAt.localeCompare(right.authoredAt) || commitKey(left).localeCompare(commitKey(right)));
      checkpoint.metrics.searchedCommits = checkpoint.searched.length;
      const searchedKeys = new Set(checkpoint.searched.map(commitKey));
      checkpoint.metrics.removedCommits = checkpoint.previous
        ? Object.keys(checkpoint.previous.commits).filter((key) => !searchedKeys.has(key)).length
        : 0;
      checkpoint.cursor = { stage: "details", index: 0, page: 1, filenames: [], fileCount: 0 };
    }
    return true;
  }
  if (cursor.stage === "details") {
    const commit = checkpoint.searched[cursor.index];
    if (!commit) {
      if (!checkpoint.profile) {
        throw new Error("Collection profile is missing.");
      }
      checkpoint.result = assembleCollectionResult({
        username: checkpoint.username,
        now: new Date(checkpoint.period.to),
        from: new Date(checkpoint.period.from),
        ...checkpoint.profile,
        searchedCommits: checkpoint.searched.length,
        commits: new Map(Object.entries(checkpoint.commits)),
        previous: checkpoint.previous,
        metrics: { ...checkpoint.metrics },
        classifier,
      });
      checkpoint.cursor = { stage: "complete" };
      checkpoint.status = "ready";
      return true;
    }
    const cached = checkpoint.previous?.commits[commitKey(commit)];
    if (cached && cursor.page === 1) {
      checkpoint.commits[commitKey(commit)] = { ...commit, languages: cached.languages };
      checkpoint.metrics.cacheHits += 1;
      cursor.index += 1;
      return true;
    }
  }
  return false;
}

export function acceptPage(checkpoint: CollectionCheckpoint, page: PageResult, classifier: LanguageClassifier): void {
  const cursor = checkpoint.cursor;
  if (cursor.stage === "profile" && page.kind === "profile") {
    checkpoint.username = page.login;
    checkpoint.profile = { publicRepositories: page.publicRepositories, stars: 0 };
    checkpoint.cursor = { stage: "repositories", page: 1 };
    return;
  }
  if (cursor.stage === "repositories" && page.kind === "repositories" && checkpoint.profile) {
    checkpoint.profile.stars += page.stars;
    if (page.hasNext) {
      cursor.page += 1;
    } else {
      checkpoint.cursor = {
        stage: "search",
        pending: [{ from: Date.parse(checkpoint.period.from), to: Date.parse(checkpoint.period.to) }],
        current: null,
      };
    }
    return;
  }
  if (cursor.stage === "search" && page.kind === "search" && cursor.current) {
    const range = cursor.current;
    const split = () => {
      cursor.pending.unshift(...splitSearchInterval(range.from, range.to));
      cursor.current = null;
    };
    if (page.incomplete || (range.page === 1 && page.totalCount >= 1_000)) {
      split();
      return;
    }
    range.totalCount ??= page.totalCount;
    range.commits.push(...page.commits);
    if (new Set(range.commits.map(commitKey)).size !== range.commits.length || range.commits.length > range.totalCount) {
      split();
      return;
    }
    if (page.hasNext && range.page >= 10) {
      split();
      return;
    }
    if (page.hasNext) {
      range.page += 1;
      return;
    }
    if (new Set(range.commits.map(commitKey)).size !== range.commits.length || range.commits.length !== range.totalCount) {
      split();
      return;
    }
    checkpoint.searched.push(...range.commits);
    cursor.current = null;
    return;
  }
  if (cursor.stage === "details" && page.kind === "files") {
    const commit = checkpoint.searched[cursor.index];
    if (!commit) {
      throw new Error("Detail cursor has no commit.");
    }
    const fileCount = cursor.fileCount + page.fileCount;
    if (fileCount >= 3_000) {
      throw new Error(`Commit ${commit.repository}@${commit.sha} reached GitHub's 3,000-file response limit.`);
    }
    const filenames = [...cursor.filenames, ...page.filenames];
    if (page.hasNext) {
      if (cursor.page >= 30) {
        throw new Error(`Commit ${commit.repository}@${commit.sha} has incomplete file pagination.`);
      }
      cursor.page += 1;
      cursor.fileCount = fileCount;
      cursor.filenames = filenames;
    } else {
      checkpoint.commits[commitKey(commit)] = { ...commit, languages: classifier.classifyFiles(filenames) };
      checkpoint.metrics.fetchedCommits += 1;
      checkpoint.cursor = { stage: "details", index: cursor.index + 1, page: 1, filenames: [], fileCount: 0 };
    }
    return;
  }
  throw new Error("GitHub page does not match the current collection stage.");
}
