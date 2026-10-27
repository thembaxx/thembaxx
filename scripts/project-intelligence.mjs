import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const owner = "thembaxx";
const shaPattern = /^[a-f0-9]{40,64}$/i;
const failures = new Set(["failure", "startup_failure", "timed_out", "action_required"]);
const excludedEvents = new Set(["dynamic", "workflow_run", "pull_request", "pull_request_target"]);

export function selectWorkflowResults(runs, branch, head) {
  const latest = new Map();
  for (const run of [...runs].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  )) {
    if (run.head_branch !== branch || excludedEvents.has(run.event)) continue;
    const key = run.workflow_id ?? run.path ?? run.name;
    if (key == null || latest.has(key)) continue;
    latest.set(key, {
      id: run.id,
      workflowId: key,
      name: run.name || "Unnamed workflow",
      conclusion: run.conclusion ?? null,
      status: run.status ?? "unknown",
      event: run.event,
      sha: shaPattern.test(run.head_sha || "") ? run.head_sha : null,
      url: run.html_url,
      createdAt: run.created_at,
      isCurrentHead: head ? run.head_sha === head : null,
      checkSuiteId: run.check_suite_id,
    });
  }
  return [...latest.values()];
}

export function summarizeCurrentChecks(workflows, head) {
  const current = workflows.filter((run) => run.isCurrentHead === true);
  let state = "unknown";
  if (head) {
    if (!current.length) state = "not-checked";
    else if (current.some((run) => failures.has(run.conclusion))) state = "failing";
    else if (current.some((run) => run.status !== "completed")) state = "in-progress";
    else if (current.some((run) => run.conclusion !== "success")) state = "incomplete";
    else state = current.length === workflows.length ? "passing" : "partially-checked";
  }
  return {
    state,
    workflowCount: current.length,
    olderWorkflowCount: workflows.length - current.length,
  };
}

// Missing steps or logs never establish an Actions billing problem.
export function classifyActionsAnnotation(annotation) {
  const message = [annotation?.title, annotation?.message, annotation?.summary, annotation?.text]
    .filter((value) => typeof value === "string")
    .map((value) => value.slice(0, 20000))
    .join(" ");
  return /recent account payments have failed|spending limit needs to be increased|(?:github actions|actions) (?:minutes|usage) (?:quota|limit) (?:has been |was )?exceeded/i.test(
    message,
  )
    ? "actions-billing"
    : "unverified";
}

function client(fetchImpl, token) {
  return async (path) => {
    const url = new URL(path, "https://api.github.com");
    if (
      url.origin !== "https://api.github.com" ||
      !(
        url.pathname.startsWith("/repos/" + owner + "/") ||
        url.pathname === "/users/" + owner + "/repos" ||
        url.pathname === "/user/repos"
      )
    )
      throw new Error("Unexpected GitHub API path");
    const response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "thembaxx-project-intelligence/2.0",
      },
    });
    if (!response.ok) throw new Error("GitHub API " + response.status + " for " + url.pathname);
    return response.json();
  };
}

async function deploymentIdentity(github, path) {
  const deployments = await github(path + "/deployments?per_page=10");
  if (!Array.isArray(deployments)) throw new Error("Unexpected deployment response");
  const production = deployments.filter((item) =>
    /^(production|prod)$/i.test(item.environment || ""),
  );
  for (const deployment of production.slice(0, 3)) {
    const statuses = await github(path + "/deployments/" + deployment.id + "/statuses?per_page=10");
    if (!Array.isArray(statuses)) throw new Error("Unexpected deployment status response");
    const latest = [...statuses].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    )[0];
    if (latest?.state !== "success" || !shaPattern.test(deployment.sha || "")) continue;
    let url = null;
    try {
      const parsed = new URL(latest.environment_url);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.href;
    } catch {}
    return {
      state: "success",
      sha: deployment.sha,
      url,
      environment: deployment.environment,
      observedAt: latest.created_at,
    };
  }
  return { state: "unknown", sha: null, url: null };
}

async function failureEvidence(github, path, run) {
  if (!Number.isSafeInteger(run.checkSuiteId) || run.checkSuiteId < 1)
    return { kind: "unverified" };
  const result = await github(
    path + "/check-suites/" + run.checkSuiteId + "/check-runs?per_page=100",
  );
  if (!Array.isArray(result.check_runs)) throw new Error("Unexpected check-run response");
  for (const check of result.check_runs
    .filter((item) => failures.has(item.conclusion))
    .slice(0, 5)) {
    if (classifyActionsAnnotation(check.output) === "actions-billing")
      return { kind: "actions-billing", checkRunId: check.id };
    if (!check.output?.annotations_count) continue;
    const annotations = await github(
      path + "/check-runs/" + check.id + "/annotations?per_page=100",
    );
    if (!Array.isArray(annotations)) throw new Error("Unexpected annotation response");
    if (
      annotations.some((annotation) => classifyActionsAnnotation(annotation) === "actions-billing")
    ) {
      // Classifications are retained, never raw annotations or log contents.
      return { kind: "actions-billing", checkRunId: check.id };
    }
  }
  return { kind: "unverified" };
}

export async function collectProjectIntelligence({
  fetchImpl = fetch,
  token = process.env.REPO_AUDIT_TOKEN || process.env.GITHUB_TOKEN,
  includePrivate = Boolean(process.env.REPO_AUDIT_TOKEN),
  now = Date.now(),
} = {}) {
  if (!token) throw new Error("GITHUB_TOKEN is required for the GitHub-only report");
  const github = client(fetchImpl, token);
  const since = new Date(now - 14 * 86400000).toISOString();
  const repos = [];
  let repositorySampleMayBeTruncated = false;
  const endpoint = includePrivate
    ? "/user/repos?affiliation=owner&per_page=100"
    : "/users/" + owner + "/repos?type=owner&per_page=100";
  for (let page = 1; page <= 4; page++) {
    const items = await github(endpoint + "&page=" + page);
    if (!Array.isArray(items)) throw new Error("Unexpected repository response");
    repos.push(
      ...items.filter((repo) => repo.owner?.login?.toLowerCase() === owner && !repo.archived),
    );
    if (items.length < 100) break;
    if (page === 4) repositorySampleMayBeTruncated = true;
  }
  const projects = [];
  for (const repo of repos.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[\w.-]+$/.test(repo.name)) continue;
    const path = "/repos/" + owner + "/" + encodeURIComponent(repo.name);
    const item = {
      repository: owner + "/" + repo.name,
      windowDays: 14,
      ci: { success: 0, failure: 0, cancelled: 0, skipped: 0 },
      latest: null,
      openIssues: null,
      errors: [],
      warnings: [],
      defaultBranch: null,
      defaultHeadSha: null,
      workflows: [],
      current: { state: "unknown", workflowCount: 0, olderWorkflowCount: 0 },
      deployment: { state: "unknown", sha: null, url: null },
      deploymentMatchesHead: null,
    };
    try {
      const meta = await github(path);
      item.defaultBranch = meta.default_branch || null;
      item.openIssues = meta.open_issues_count ?? null;
      if (!item.defaultBranch) throw new Error("Default branch is unknown");
      const [runs, branch] = await Promise.all([
        github(
          path + "/actions/runs?branch=" + encodeURIComponent(item.defaultBranch) + "&per_page=100",
        ),
        github(path + "/branches/" + encodeURIComponent(item.defaultBranch)),
      ]);
      item.defaultHeadSha = shaPattern.test(branch.commit?.sha || "") ? branch.commit.sha : null;
      if (!Array.isArray(runs.workflow_runs)) throw new Error("Unexpected workflow response");
      const relevant = runs.workflow_runs.filter(
        (run) => run.head_branch === item.defaultBranch && !excludedEvents.has(run.event),
      );
      for (const run of relevant.filter((run) => run.created_at >= since)) {
        if (Object.hasOwn(item.ci, run.conclusion)) item.ci[run.conclusion]++;
        else if (!run.conclusion) item.ci.inProgress = (item.ci.inProgress || 0) + 1;
      }
      item.workflows = selectWorkflowResults(relevant, item.defaultBranch, item.defaultHeadSha);
      item.current = summarizeCurrentChecks(item.workflows, item.defaultHeadSha);
      const current = item.workflows.filter((run) => run.isCurrentHead);
      const observed = current.find((run) => failures.has(run.conclusion)) || current[0];
      item.latest = observed
        ? {
            name: observed.name,
            conclusion: observed.conclusion,
            url: observed.url,
            sha: observed.sha,
          }
        : null;
      item.sampleMayBeTruncated = runs.total_count > runs.workflow_runs.length;
      for (const run of current.filter((entry) => failures.has(entry.conclusion)).slice(0, 3)) {
        try {
          run.failureEvidence = await failureEvidence(github, path, run);
        } catch (error) {
          run.failureEvidence = { kind: "unverified" };
          item.warnings.push("Failure annotations unavailable: " + error.message);
        }
      }
      try {
        item.deployment = await deploymentIdentity(github, path);
        item.deploymentMatchesHead =
          item.deployment.sha && item.defaultHeadSha
            ? item.deployment.sha === item.defaultHeadSha
            : null;
      } catch (error) {
        item.warnings.push("Production deployment unknown: " + error.message);
      }
    } catch (error) {
      item.errors.push(error.message);
    }
    projects.push(item);
  }
  return {
    generatedAt: new Date(now).toISOString(),
    methodology:
      "All accessible, unarchived owner repositories. Current status uses latest observations per default-branch workflow at the current head. Historical totals are a bounded 14-day default-branch sample. Issue counts do not establish current failures. Deployment and annotation evidence may be unavailable. No product usage or revenue inferred.",
    scope: includePrivate
      ? "Owner token visibility"
      : "Public repositories only; set REPO_AUDIT_TOKEN for private repositories",
    windowDays: 14,
    repositorySampleMayBeTruncated,
    projects,
  };
}

const markdown = (value) => String(value).replace(/[|\r\n]/g, " ");
export function renderProjectSummary(result) {
  const labels = {
    passing: "Passing",
    failing: "Failing",
    "in-progress": "In progress",
    incomplete: "Incomplete",
    "partially-checked": "Passing sampled checks; others older",
    "not-checked": "Not checked",
    unknown: "Unknown",
  };
  const rows = result.projects.map((project) => {
    const state = project.errors.length ? "Unavailable" : labels[project.current.state];
    const billing = project.workflows.some(
      (run) => run.failureEvidence?.kind === "actions-billing",
    );
    const head = project.defaultHeadSha?.slice(0, 8) || "unknown";
    const deployed = project.deployment.sha
      ? project.deployment.sha.slice(0, 8) +
        (project.deploymentMatchesHead === true
          ? " (matches head)"
          : project.deploymentMatchesHead === false
            ? " (different from head)"
            : " (head unknown)")
      : "unknown";
    return (
      "| [" +
      markdown(project.repository.split("/")[1]) +
      "](https://github.com/" +
      project.repository +
      ") | " +
      head +
      " | " +
      state +
      (billing ? " · Actions billing annotation" : "") +
      " | " +
      project.ci.success +
      " / " +
      project.ci.failure +
      " | " +
      deployed +
      " |"
    );
  });
  const details = result.projects.flatMap((project) =>
    project.workflows.map(
      (run) =>
        "- " +
        markdown(project.repository) +
        " · **" +
        markdown(run.name) +
        "**: [" +
        markdown(run.conclusion || run.status) +
        "](" +
        run.url +
        ") · " +
        (run.sha?.slice(0, 8) || "unknown SHA") +
        " · " +
        (run.isCurrentHead === true
          ? "current head"
          : run.isCurrentHead === false
            ? "older/different commit"
            : "head unknown") +
        (run.failureEvidence?.kind === "actions-billing"
          ? " · explicit Actions billing annotation"
          : ""),
    ),
  );
  return (
    [
      "## Weekly project intelligence",
      "",
      "Current default-branch evidence and separate historical totals. Open issues do not determine current health.",
      "Coverage: " + result.scope + " (" + result.projects.length + " repositories).",
      "",
      "| Repository | Default head | Current-head checks | 14-day success / failure | Successful production deployment |",
      "| --- | --- | --- | ---: | --- |",
      ...rows,
      "",
      "### Workflow observations",
      ...details,
      "",
      "A passing sample does not establish every production capability. Older results, cancelled/skipped checks, unavailable APIs and absent deployment records are not proof of a working release.",
      "Billing is identified only from explicit check annotations; failed jobs without steps or logs retain an unverified cause. No annotation text or logs are copied.",
      "Production identity is the newest successful non-inactive status found in up to ten recent deployments (three production records checked). Unknown is not failure.",
      "Histories are bounded to 100 runs per repository and 400 repositories. Inspect JSON truncation flags.",
      "Visitors, retention, revenue and conversion are unknown. Private repositories require owner-authorized token visibility.",
    ].join("\n") + "\n"
  );
}

export async function main(options) {
  const result = await collectProjectIntelligence(options);
  await mkdir("reports", { recursive: true });
  await writeFile("reports/project-intelligence.json", JSON.stringify(result, null, 2) + "\n");
  const summary = renderProjectSummary(result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (result.projects.some((project) => project.errors.length || project.warnings.length))
    console.warn("Some evidence unavailable; see report JSON.");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
