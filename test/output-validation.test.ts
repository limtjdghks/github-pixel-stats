import assert from "node:assert/strict";
import test from "node:test";
import { LinguistClassifier } from "../src/data/linguist.js";
import type { CollectorState, StatsSnapshot } from "../src/model.js";
import { renderLanguagesCard, renderPreviewHtml, renderStatsCard } from "../src/render/index.js";
import {
  validateGeneratedOutput,
  type GeneratedOutput,
} from "../src/validation/output.js";
import {
  loadUserFixture,
  USER_FIXTURE_NAMES,
  type UserFixtureName,
} from "./helpers/load-user-fixture.js";

interface ValidOutput extends GeneratedOutput {
  snapshot: StatsSnapshot;
}

const classifierPromise = LinguistClassifier.loadDefault();

function renderOutput(
  snapshot: StatsSnapshot,
  state: CollectorState,
  classifier: LinguistClassifier,
): ValidOutput {
  const statsSvg = renderStatsCard(snapshot);
  const languagesSvg = renderLanguagesCard(snapshot);
  return {
    snapshot,
    state,
    statsSvg,
    languagesSvg,
    preview: renderPreviewHtml(statsSvg, languagesSvg),
    classifier,
  };
}

async function buildOutput(name: UserFixtureName): Promise<ValidOutput> {
  const [fixture, classifier] = await Promise.all([
    loadUserFixture(name),
    classifierPromise,
  ]);
  return renderOutput(fixture.snapshot, fixture.state, classifier);
}

function cloneOutput(output: ValidOutput): ValidOutput {
  return {
    ...output,
    snapshot: structuredClone(output.snapshot),
    state: structuredClone(output.state),
  };
}

function rerender(output: ValidOutput): ValidOutput {
  return renderOutput(output.snapshot, output.state, output.classifier);
}

for (const fixtureName of USER_FIXTURE_NAMES) {
  test(`${fixtureName} renders and validates generated output`, async () => {
    const output = await buildOutput(fixtureName);

    assert.doesNotThrow(() => validateGeneratedOutput(output));
  });
}

test("fixture-alpha uses every language touch as the top-five share denominator", async () => {
  const output = await buildOutput("fixture-alpha");
  const allLanguageTouches = Object.values(output.state.commits).reduce(
    (total, commit) => total + new Set(commit.languages).size,
    0,
  );

  assert.equal(allLanguageTouches, 18);
  assert.deepEqual(
    output.snapshot.languages.map(({ name, commitCount }) => ({ name, commitCount })),
    [
      { name: "TypeScript", commitCount: 3 },
      { name: "CSS", commitCount: 2 },
      { name: "JavaScript", commitCount: 2 },
      { name: "Python", commitCount: 2 },
      { name: "C#", commitCount: 1 },
    ],
  );
  for (const language of output.snapshot.languages) {
    assert.ok(Math.abs(language.share - language.commitCount / allLanguageTouches) < 0.000001);
  }
});

test("fixture-beta preserves sparse activity and empty language output", async () => {
  const output = await buildOutput("fixture-beta");

  assert.deepEqual(output.snapshot.activity.days, [
    { date: "2026-09-10", commits: 0 },
    { date: "2026-09-11", commits: 1 },
    { date: "2026-09-12", commits: 0 },
  ]);
  assert.deepEqual(output.snapshot.languages, []);
  assert.match(output.languagesSvg, /NO LANGUAGE DATA YET/);
});

const snapshotCases: Array<{
  name: string;
  mutate: (output: ValidOutput) => void;
  expected: RegExp;
  rerender?: boolean;
}> = [
  {
    name: "unsupported snapshot schema",
    mutate: (output) => Object.assign(output.snapshot, { schemaVersion: 2 }),
    expected: /unsupported schema version/,
  },
  {
    name: "unexpected snapshot username",
    mutate: (output) => Object.assign(output.snapshot, { username: "fixture-alpha" }),
    expected: /unexpected username/,
  },
  {
    name: "activity date sequence mismatch",
    mutate: (output) => {
      output.snapshot.activity.days[0]!.date = "2026-09-08";
    },
    expected: /Activity day 0 has an invalid date sequence/,
  },
  {
    name: "activity total mismatch",
    mutate: (output) => {
      output.snapshot.activity.days[0]!.commits += 1;
    },
    expected: /Activity and snapshot commit totals differ/,
  },
  {
    name: "language share mismatch",
    mutate: (output) => {
      output.snapshot.languages[0]!.share = 0.5;
    },
    expected: /Language TypeScript has an invalid share/,
    rerender: true,
  },
  {
    name: "language segment mismatch",
    mutate: (output) => {
      output.snapshot.languages[0]!.filledSegments = 3;
    },
    expected: /Language TypeScript has an invalid bar/,
    rerender: true,
  },
  {
    name: "language color mismatch",
    mutate: (output) => {
      output.snapshot.languages[0]!.color = "#000000";
    },
    expected: /Language TypeScript has an invalid Linguist color/,
    rerender: true,
  },
];

for (const fixtureCase of snapshotCases) {
  test(`validation rejects ${fixtureCase.name}`, async () => {
    let output = cloneOutput(await buildOutput("fixture-alpha"));
    fixtureCase.mutate(output);
    if (fixtureCase.rerender) {
      output = rerender(output);
    }

    assert.throws(() => validateGeneratedOutput(output), fixtureCase.expected);
  });
}

test("validation rejects a state and snapshot commit total mismatch", async () => {
  const output = cloneOutput(await buildOutput("fixture-alpha"));
  const commitKey = Object.keys(output.state.commits)[0];
  assert.ok(commitKey);
  delete output.state.commits[commitKey];

  assert.throws(
    () => validateGeneratedOutput(output),
    /State and snapshot commit totals differ/,
  );
});

test("validation rejects a state commit outside the snapshot period", async () => {
  const output = cloneOutput(await buildOutput("fixture-alpha"));
  const commit = Object.values(output.state.commits)[0];
  assert.ok(commit);
  commit.authoredAt = "2026-09-08T23:59:59.999Z";

  assert.throws(
    () => validateGeneratedOutput(output),
    /State commit .+ is outside the snapshot period/,
  );
});

const svgCases: Array<{
  name: string;
  mutate: (svg: string) => string;
  expected: RegExp;
}> = [
  {
    name: "unexpected SVG size",
    mutate: (svg) => svg.replace('width="570" height="300"', 'width="571" height="300"'),
    expected: /stats\.svg has an unexpected size/,
  },
  {
    name: "missing SVG accessibility role",
    mutate: (svg) => svg.replace(' role="img"', ""),
    expected: /stats\.svg has no image role/,
  },
  {
    name: "external SVG URL",
    mutate: (svg) => svg.replace("</svg>", '<a href="https://example.com"/></svg>'),
    expected: /stats\.svg contains an external URL/,
  },
  {
    name: "SVG script",
    mutate: (svg) => svg.replace("</svg>", "<script/></svg>"),
    expected: /stats\.svg contains a script/,
  },
  {
    name: "SVG foreignObject",
    mutate: (svg) => svg.replace("</svg>", "<foreignObject/></svg>"),
    expected: /stats\.svg contains foreignObject/,
  },
];

for (const fixtureCase of svgCases) {
  test(`validation rejects ${fixtureCase.name}`, async () => {
    const output = cloneOutput(await buildOutput("fixture-alpha"));
    output.statsSvg = fixtureCase.mutate(output.statsSvg);

    assert.throws(() => validateGeneratedOutput(output), fixtureCase.expected);
  });
}

test("validation rejects a preview without both card references", async () => {
  const output = cloneOutput(await buildOutput("fixture-alpha"));
  output.preview = output.preview.replace('src="./stats.svg"', 'src="./missing.svg"');

  assert.throws(
    () => validateGeneratedOutput(output),
    /index\.html does not reference both cards/,
  );
});
