import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyActionsAnnotation,
  collectProjectIntelligence,
  renderProjectSummary,
  selectWorkflowResults,
  summarizeCurrentChecks,
} from "./project-intelligence.mjs";

const head = "a".repeat(40);
const previous = "b".repeat(40);
const now = Date.parse("2026-10-26T12:00:00Z");
const run = (overrides = {}) => ({
  id: 1,
  workflow_id: 10,
  name: "App checks",
  head_branch: "main",
  head_sha: head,
  status: "completed",
  conclusion: "success",
  event: "push",
  created_at: "2026-10-26T10:00:00Z",
  html_url: "https://github.com/thembaxx/example/actions/runs/1",
  ...overrides,
});

function fixture({
  runs = [run()],
  branch = head,
  deployments = [],
  extra = {},
  privateRepos = false,
} = {}) {
  const calls = [];
  const paths = {
    [(privateRepos ? "/user/repos?affiliation=owner" : "/users/thembaxx/repos?type=owner") +
    "&per_page=100&page=1"]: [
      { name: "example", owner: { login: "thembaxx" }, archived: false, private: privateRepos },
      { name: "archived", owner: { login: "thembaxx" }, archived: true },
      { name: "other", owner: { login: "another-owner" }, archived: false },
    ],
    "/repos/thembaxx/example": { default_branch: "main", open_issues_count: 7 },
    "/repos/thembaxx/example/actions/runs?branch=main&per_page=100": {
      total_count: runs.length,
      workflow_runs: runs,
    },
    "/repos/thembaxx/example/branches/main": { commit: { sha: branch } },
    "/repos/thembaxx/example/deployments?per_page=10": deployments,
    ...extra,
  };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url),
      path = parsed.pathname + parsed.search;
    calls.push({ path, method: options.method });
    assert.equal(parsed.origin, "https://api.github.com");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.ok(options.headers.Authorization);
    const value = paths[path];
    if (value === undefined) throw new Error("Unexpected fixture request: " + path);
    if (value?.httpError) return { ok: false, status: value.httpError };
    return { ok: true, status: 200, json: async () => structuredClone(value) };
  };
  return { fetchImpl, calls };
}

test("old failure followed by current success does not make current status failing", () => {
  const workflows = selectWorkflowResults(
    [
      run({ id: 2 }),
      run({ head_sha: previous, conclusion: "failure", created_at: "2026-10-25T10:00:00Z" }),
    ],
    "main",
    head,
  );
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].id, 2);
  assert.equal(summarizeCurrentChecks(workflows, head).state, "passing");
});

test("newer PR, updater and workflow-run triage cannot replace default-branch evidence", () => {
  const workflows = selectWorkflowResults(
    [
      run(),
      run({ id: 2, event: "pull_request", created_at: "2026-10-26T11:00:00Z" }),
      run({ id: 3, event: "dynamic", created_at: "2026-10-26T11:01:00Z" }),
      run({ id: 4, event: "workflow_run", created_at: "2026-10-26T11:02:00Z" }),
      run({ id: 5, head_branch: "feature", created_at: "2026-10-26T11:03:00Z" }),
    ],
    "main",
    head,
  );
  assert.deepEqual(
    workflows.map((item) => item.id),
    [1],
  );
});

test("old success is not current proof; partial, skipped and unknown observations stay explicit", () => {
  const old = selectWorkflowResults([run({ head_sha: previous })], "main", head);
  assert.equal(summarizeCurrentChecks(old, head).state, "not-checked");
  const mixed = selectWorkflowResults(
    [run(), run({ workflow_id: 11, head_sha: previous })],
    "main",
    head,
  );
  assert.equal(summarizeCurrentChecks(mixed, head).state, "partially-checked");
  for (const conclusion of ["cancelled", "skipped", "neutral"]) {
    assert.equal(
      summarizeCurrentChecks(selectWorkflowResults([run({ conclusion })], "main", head), head)
        .state,
      "incomplete",
    );
  }
  assert.equal(summarizeCurrentChecks(mixed, null).state, "unknown");
});

test("billing classification requires explicit annotation evidence", () => {
  assert.equal(
    classifyActionsAnnotation({
      message:
        "The job was not started because recent account payments have failed or your spending limit needs to be increased.",
    }),
    "actions-billing",
  );
  assert.equal(
    classifyActionsAnnotation({ message: "GitHub Actions minutes quota exceeded." }),
    "actions-billing",
  );
  for (const value of [
    undefined,
    { steps: [] },
    { message: "Payment gateway test failed." },
    { title: "Job failed", summary: "Logs unavailable" },
  ]) {
    assert.equal(classifyActionsAnnotation(value), "unverified");
  }
});

test("collector separates historical counts, issue counts, current checks and deployed commit", async () => {
  const { fetchImpl, calls } = fixture({
    privateRepos: true,
    runs: [
      run(),
      run({ id: 9, head_sha: previous, conclusion: "failure", created_at: "2026-10-25T10:00:00Z" }),
    ],
    deployments: [{ id: 4, environment: "Production", sha: previous }],
    extra: {
      "/repos/thembaxx/example/deployments/4/statuses?per_page=10": [
        {
          state: "success",
          environment_url: "https://example.vercel.app",
          created_at: "2026-10-26T09:00:00Z",
        },
      ],
    },
  });
  const report = await collectProjectIntelligence({
    fetchImpl,
    token: "fixture-token",
    includePrivate: true,
    now,
  });
  assert.equal(report.projects.length, 1);
  const project = report.projects[0];
  assert.equal(project.current.state, "passing");
  assert.equal(project.ci.failure, 1);
  assert.equal(project.openIssues, 7);
  assert.equal(project.latest.conclusion, "success");
  assert.equal(project.latest.sha, head);
  assert.equal(project.deployment.sha, previous);
  assert.equal(project.deploymentMatchesHead, false);
  assert.equal(project.errors.length, 0);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.match(renderProjectSummary(report), /Passing/);
  assert.match(renderProjectSummary(report), /different from head/);
  assert.doesNotMatch(JSON.stringify(report), /fixture-token/);
});

test("only current-head runs populate the backward-compatible latest field", async () => {
  const { fetchImpl } = fixture({ runs: [run({ head_sha: previous })] });
  const report = await collectProjectIntelligence({ fetchImpl, token: "fixture-token", now });
  assert.equal(report.projects[0].latest, null);
  assert.equal(report.projects[0].current.state, "not-checked");
  assert.match(renderProjectSummary(report), /older\/different commit/);
});

test("confirmed billing annotations are classified without copying annotation contents", async () => {
  const message =
    "The job was not started because recent account payments have failed. PRIVATE-ANNOTATION-CONTENT";
  const { fetchImpl } = fixture({
    runs: [run({ conclusion: "failure", check_suite_id: 3 })],
    extra: {
      "/repos/thembaxx/example/check-suites/3/check-runs?per_page=100": {
        check_runs: [{ id: 5, conclusion: "failure", output: { annotations_count: 1 } }],
      },
      "/repos/thembaxx/example/check-runs/5/annotations?per_page=100": [{ message }],
    },
  });
  const report = await collectProjectIntelligence({ fetchImpl, token: "fixture-token", now });
  assert.equal(report.projects[0].workflows[0].failureEvidence.kind, "actions-billing");
  assert.match(renderProjectSummary(report), /Actions billing annotation/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-ANNOTATION-CONTENT|recent account payments/);
});

test("restricted deployment/check permissions stay unknown without hiding current failures", async () => {
  const { fetchImpl } = fixture({
    runs: [run({ conclusion: "failure", check_suite_id: 3 })],
    extra: {
      "/repos/thembaxx/example/check-suites/3/check-runs?per_page=100": { httpError: 403 },
      "/repos/thembaxx/example/deployments?per_page=10": { httpError: 403 },
    },
  });
  const {
    projects: [project],
  } = await collectProjectIntelligence({ fetchImpl, token: "fixture-token", now });
  assert.equal(project.current.state, "failing");
  assert.equal(project.workflows[0].failureEvidence.kind, "unverified");
  assert.equal(project.deployment.state, "unknown");
  assert.equal(project.deploymentMatchesHead, null);
  assert.equal(project.errors.length, 0);
  assert.equal(project.warnings.length, 2);
});

test("a failed job without annotations does not acquire a billing cause", async () => {
  const { fetchImpl } = fixture({
    runs: [run({ conclusion: "failure", check_suite_id: 3 })],
    extra: {
      "/repos/thembaxx/example/check-suites/3/check-runs?per_page=100": {
        check_runs: [
          {
            id: 5,
            conclusion: "failure",
            output: { annotations_count: 0, summary: "No logs available" },
          },
        ],
      },
    },
  });
  const {
    projects: [project],
  } = await collectProjectIntelligence({ fetchImpl, token: "fixture-token", now });
  assert.equal(project.workflows[0].failureEvidence.kind, "unverified");
});

test("an unavailable head API cannot invent passing results", async () => {
  const { fetchImpl } = fixture({
    extra: { "/repos/thembaxx/example/branches/main": { httpError: 404 } },
  });
  const report = await collectProjectIntelligence({ fetchImpl, token: "fixture-token", now });
  assert.equal(report.projects[0].current.state, "unknown");
  assert.equal(report.projects[0].latest, null);
  assert.equal(report.projects[0].errors.length, 1);
  assert.match(renderProjectSummary(report), /Unavailable/);
});

test("inactive deployment is not reported as a successful production deployment", async () => {
  const { fetchImpl } = fixture({
    deployments: [{ id: 4, environment: "production", sha: head }],
    extra: {
      "/repos/thembaxx/example/deployments/4/statuses?per_page=10": [
        { state: "inactive", created_at: "2026-10-26T11:00:00Z" },
        { state: "success", created_at: "2026-10-26T09:00:00Z" },
      ],
    },
  });
  const {
    projects: [project],
  } = await collectProjectIntelligence({ fetchImpl, token: "fixture-token", now });
  assert.equal(project.deployment.state, "unknown");
  assert.equal(project.deployment.sha, null);
});

test("a known deployment cannot be labelled a mismatch when the head is unknown", async () => {
  const { fetchImpl } = fixture({
    branch: null,
    deployments: [{ id: 4, environment: "production", sha: previous }],
    extra: {
      "/repos/thembaxx/example/deployments/4/statuses?per_page=10": [
        { state: "success", created_at: "2026-10-26T09:00:00Z" },
      ],
    },
  });
  const report = await collectProjectIntelligence({ fetchImpl, token: "fixture-token", now });
  assert.equal(report.projects[0].deploymentMatchesHead, null);
  assert.match(renderProjectSummary(report), /head unknown/);
  assert.doesNotMatch(renderProjectSummary(report), /different from head/);
});
