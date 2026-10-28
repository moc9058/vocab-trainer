import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const { f, scope, preview, candidate, scopeRequest } = JSON.parse(
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/tests/math-browser-fixture.ts"],
    { cwd: resolve(process.cwd(), "../backend"), encoding: "utf8" },
  ),
);
const request = () => structuredClone(scopeRequest);
async function base(page: Page) {
  page.on("pageerror", (e) => console.error("BROWSER ERROR", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("BROWSER CONSOLE", m.text());
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/me")
        return route.fulfill({
          json: { authEnabled: false, authenticated: true, user: null },
        });
      if (path === "/api/languages/")
        return route.fulfill({
          status: 500,
          json: { error: "language unavailable" },
        });
      if (path === "/api/math/catalog")
        return route.fulfill({
          json: {
            activeCatalogId: f.catalog.id,
            subjects: f.catalog.subjects,
            capabilities: { generate: true },
          },
        });
      if (path.endsWith("/nodes"))
        return route.fulfill({
          json: { items: f.catalog.nodes, nextCursor: null },
        });
      if (path === "/api/math/foundation-profiles")
        return route.fulfill({ json: { profiles: [] } });
      if (path === "/api/math/scope-previews")
        return route.fulfill({ json: preview });
      if (path === "/api/math/tests")
        return route.fulfill({ json: { items: [], nextCursor: null } });
      if (path.includes("/learning-states/"))
        return route.fulfill({ json: { state: null, items: [] } });
      if (path.includes("/concepts/"))
        return route.fulfill({
          json: f.catalog.concepts.find((c: any) => path.endsWith(c.id)),
        });
      return route.fulfill({ status: 404, json: { error: "not found" } });
    },
  );
}
test("math card survives a failed language API; empty catalog and unknown math route stay independent", async ({
  page,
}) => {
  await base(page);
  await page.route("**/api/math/catalog", (route) =>
    route.fulfill({
      json: {
        activeCatalogId: null,
        subjects: [],
        capabilities: { generate: false },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Mathematics/ }).click();
  await expect(page.getByText("No published learning units yet")).toBeVisible();
  await expect(
    page.getByText(/Question generation is not configured/),
  ).toBeVisible();
  await page.goto("/math/unknown");
  await expect(page.getByRole("alert")).toContainText(
    "This mathematics page was not found",
  );
});
test("math v2 starts from range and difficulty without policy or preview consent", async ({ page }) => {
  await base(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const calls: { path: string; body: any }[] = [];
  await page.route("**/api/math/scope-previews", (route) => {
    calls.push({ path: "preview", body: route.request().postDataJSON() });
    return route.fulfill({ json: { schemaVersion: 2, previewId: "v2-preview", scopeHash: "v2-hash", catalogId: f.catalog.id,
      curriculumHash: "curriculum", eligibleObjectiveCount: 1, compactSummary: { targets: 1, prerequisites: 2 }, expiresAt: Date.now() + 60000 } });
  });
  await page.route("**/api/math/tests", (route) => {
    calls.push({ path: "create", body: route.request().postDataJSON() });
    return route.fulfill({ status: 201, json: { testId: "created-v2", jobId: "job-v2" } });
  });
  await page.goto("/math/subjects/linear-algebra");
  await expect(page.getByRole("textbox", { name: "Search titles" })).toHaveCount(0);
  await expect(page.getByText("Knowledge policy", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start test", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByLabel("Questions (optional)", { exact: true }).fill("21");
  await expect(page.getByRole("button", { name: "Start test", exact: true })).toBeDisabled();
  await page.getByLabel("Questions (optional)", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "Start test", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Start test", exact: true }).click();
  await expect(page).toHaveURL(/math\/tests\/created-v2/);
  expect(calls.map((c) => c.path)).toEqual(["preview", "create"]);
  expect(calls[0].body).toEqual({ schemaVersion: 2, subjectId: "linear-algebra", selectedNodeIds: expect.any(Array), difficulty: 2, responseLanguage: "en" });
  expect(calls[0].body.selectedNodeIds.length).toBeGreaterThan(0);
  expect(calls[1].body).toEqual({ schemaVersion: 2, previewId: "v2-preview", scopeHash: "v2-hash", operationId: "create-v2-preview" });
});
test("math renderer is mobile-safe, includes full source hierarchy and strips unsafe HTML", async ({
  page,
}) => {
  await base(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const concept = structuredClone(f.catalog.concepts[0]);
  concept.statement +=
    "\n\n$$\n\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}\n$$\n\n<script>window.mathUnsafe=true</script>\n\n![tracker](https://example.com/tracker)";
  await page.route("**/api/math/catalogs/**/concepts/*", (route) =>
    route.fulfill({ json: concept }),
  );
  await page.goto(`/math/catalogs/${f.catalog.id}/concepts/${concept.id}`);
  await expect(page.locator(".katex")).not.toHaveCount(0);
  await expect(page.locator("math")).not.toHaveCount(0);
  await expect(page.locator(".math-citation")).toContainText("Vector Spaces");
  await expect(page.locator(".math-citation")).toContainText("Definitions");
  await expect(page.locator(".math-markdown img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).mathUnsafe)).toBeUndefined();
});
test("draft and paper submission share serial queue, complete naturally and reveal fixed citations before explanation", async ({
  page,
}) => {
  await base(page);
  const calls: string[] = [];
  const question = {
    id: "q-1",
    ordinal: 1,
    promptMarkdown: candidate.promptMarkdown,
    answerFormat: "text",
    targetObjectiveIds: candidate.targetObjectiveIds,
    difficulty: 2,
    validationStatus: "ai-validated",
    contentHash: "hash",
  };
  const view: any = {
    id: "test-fixture",
    schemaVersion: 1,
    catalogId: f.catalog.id,
    scopeHash: preview.scopeHash,
    config: request(),
    state: "in_progress",
    revision: 1,
    generationJobId: "job-fixture",
    currentSittingId: "sitting-fixture",
    questionIds: ["q-1"],
    answeredQuestionIds: [],
    invalidQuestionIds: [],
    revealedQuestionIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    questions: [question],
    attempts: [],
    drafts: [],
    sitting: {
      id: "sitting-fixture",
      state: "active",
      startedAt: Date.now(),
      endedAt: null,
      attemptIds: [],
      review: { state: "idle", revision: 0, cursor: 0, attemptIds: [] },
    },
    score: 0,
    maxScore: 100,
    pendingGrades: 0,
    scopeSummary: { targets: 1, prerequisites: 2, baseline: 0 },
    coverage: scope.coverage,
  };
  await page.route("**/api/math/tests/test-fixture**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET")
      return route.fulfill({ json: view });
    const body = route.request().postDataJSON();
    if (path.endsWith("/drafts/q-1")) {
      calls.push("draft");
      view.drafts = [
        {
          questionId: "q-1",
          answerText: body.text,
          revision: 1,
          savedAt: Date.now(),
        },
      ];
      return route.fulfill({
        json: {
          testId: view.id,
          revision: view.revision,
          draft: view.drafts[0],
        },
      });
    }
    if (path.endsWith("/attempts")) {
      calls.push("submit");
      view.answeredQuestionIds = ["q-1"];
      view.state = "completed";
      view.revision++;
      view.attempts = [
        {
          id: "attempt-fixture",
          questionId: "q-1",
          sittingId: view.currentSittingId,
          answerText: body.answerText,
          paper: true,
          skipped: false,
          assistanceUsed: false,
          assessmentState: "needs_review",
          gradeVersion: 0,
          assessment: null,
          history: [],
          submittedAt: Date.now(),
        },
      ];
      view.sitting.state = "ended";
      view.sitting.attemptIds = ["attempt-fixture"];
      return route.fulfill({
        status: 202,
        json: {
          testId: view.id,
          revision: view.revision,
          attemptId: "attempt-fixture",
        },
      });
    }
    if (path.endsWith("/reveal")) {
      view.revision++;
      return route.fulfill({
        json: {
          revision: view.revision,
          solution: {
            candidate,
            citations: f.catalog.concepts.flatMap((c: any) => c.citations),
            validation: {},
          },
        },
      });
    }
    return route.fulfill({ json: { revision: view.revision } });
  });
  await page.goto("/math/tests/test-fixture");
  await page
    .getByRole("textbox", { name: "Your answer" })
    .fill("Contains zero; addition and scalar closure hold.");
  await page
    .getByRole("button", { name: "Solved on paper / self-assess" })
    .click();
  await expect.poll(() => calls).toEqual(["draft", "submit"]);
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Question 1/ }).click();
  await page.getByRole("button", { name: /Show solution/ }).click();
  await expect(
    page.getByRole("heading", { name: "Knowledge used" }),
  ).toBeVisible();
  expect(
    await page
      .locator(".math-citation")
      .first()
      .evaluate((el) => !!el.closest("section")?.querySelector("h2")),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Resume in a new sitting" }),
  ).toHaveCount(0);
});

test("math v2 continuous tests request one next question explicitly and save drafts before finishing", async ({ page }) => {
  await base(page);
  const calls: string[] = [];
  const view: any = {
    id: "continuous-v2", schemaVersion: 2, catalogId: f.catalog.id, scopeHash: "v2", config: {
      schemaVersion: 2, subjectId: "linear-algebra", selectedNodeIds: [], difficulty: 2, responseLanguage: "en",
    }, state: "in_progress", revision: 1, generationJobId: "job-v2", generationMode: "continuous",
    questionLimit: null, generationState: "idle", generatedCount: 21, answeredCount: 21, invalidCount: 0,
    currentQuestionId: null, pendingGenerationJobId: null, currentSittingId: "sitting-v2", questionIds: [],
    answeredQuestionIds: [], invalidQuestionIds: [], revealedQuestionIds: [], createdAt: Date.now(), updatedAt: Date.now(),
    questions: [], attempts: [], drafts: [], sitting: { id: "sitting-v2", state: "active", startedAt: Date.now(),
      endedAt: null, attemptIds: [], review: { state: "idle", revision: 0, cursor: 0, attemptIds: [] } },
    score: 0, maxScore: 0, pendingGrades: 0, scopeSummary: { targets: 1, prerequisites: 2, baseline: 0 }, coverage: [],
  };
  await page.route("**/api/math/tests/continuous-v2**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/attempts") && route.request().method() === "GET")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (route.request().method() === "GET") return route.fulfill({ json: view });
    const body = route.request().postDataJSON();
    if (path.endsWith("/next-question")) {
      calls.push("next");
      expect(body.expectedRevision).toBe(1);
      view.currentQuestionId = "q-22";
      view.generatedCount++;
      view.questions = [{ id: "q-22", ordinal: 22, promptMarkdown: "Compute $1+1$.", answerFormat: "text",
        targetObjectiveIds: [], difficulty: 2, validationStatus: "ai-validated", contentHash: "q22" }];
      view.revision++;
      return route.fulfill({ status: 202, json: { questionId: "q-22", revision: view.revision } });
    }
    if (path.endsWith("/drafts/q-22")) {
      calls.push("draft");
      view.drafts = [{ questionId: "q-22", answerText: body.text, revision: 1, savedAt: Date.now() }];
      return route.fulfill({ json: { revision: view.revision, draft: view.drafts[0] } });
    }
    if (path.endsWith("/finish")) {
      calls.push("finish");
      expect(body.expectedRevision).toBe(2);
      view.state = "completed"; view.sitting.state = "ended"; view.revision++;
      return route.fulfill({ json: { revision: view.revision } });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/math/tests/continuous-v2");
  await expect(page.getByRole("button", { name: "Next question", exact: true })).toBeEnabled();
  expect(calls).toEqual([]);
  await page.getByRole("button", { name: "Next question", exact: true }).click();
  await expect(page.getByText(/Question 22/)).toBeVisible();
  await page.getByRole("textbox", { name: "Your answer" }).fill("unfinished answer");
  await page.getByRole("button", { name: "Finish test", exact: true }).click();
  await expect.poll(() => calls).toEqual(["next", "draft", "finish"]);
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next question", exact: true })).toHaveCount(0);
});

test("math v2 checkbox parents expose partial selection and work with keyboard controls", async ({ page }) => {
  await base(page);
  const treeNodes = [
    { id: "root", parentId: null, ancestorIds: [], title: "Linear Algebra", kind: "subject", unitIds: [], order: 0 },
    { id: "chapter", parentId: "root", ancestorIds: ["root"], title: "A long chapter title with mathematical foundations", kind: "chapter", unitIds: [], order: 1 },
    { id: "first", parentId: "chapter", ancestorIds: ["root", "chapter"], title: "First objective", kind: "item", unitIds: ["u1"], order: 1 },
    { id: "second", parentId: "chapter", ancestorIds: ["root", "chapter"], title: "Second objective", kind: "item", unitIds: ["u2"], order: 2 },
    { id: "blocked", parentId: "chapter", ancestorIds: ["root", "chapter"], title: "Reference only", kind: "item", unitIds: [], order: 3 },
  ];
  await page.route("**/api/math/catalogs/**/nodes?**", (route) => route.fulfill({ json: { items: treeNodes, nextCursor: null } }));
  await page.goto("/math/subjects/linear-algebra");
  const first = page.getByRole("checkbox", { name: "First objective", exact: true });
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toBeChecked();
  const root = page.getByRole("checkbox", { name: "Linear Algebra", exact: true });
  await expect(root).toHaveAttribute("aria-checked", "mixed");
  await expect(page.getByRole("checkbox", { name: /Reference only/ })).toBeDisabled();
  await page.getByRole("button", { name: "Collapse A long chapter title with mathematical foundations" }).click();
  await expect(first).toHaveCount(0);
  await page.getByRole("button", { name: "Expand A long chapter title with mathematical foundations" }).click();
  await expect(first).toBeChecked();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(root).not.toBeChecked();
});

for (const ui of [
  { language: "ja", start: "テストを開始", all: "全選択", count: "問題数（任意）", continuous: "空欄ならテストを終了するまで継続します。" },
  { language: "ko", start: "시험 시작", all: "전체 선택", count: "문제 수 (선택)", continuous: "비워 두면 시험을 종료할 때까지 계속합니다." },
]) test(`math v2 setup uses ${ui.language} labels at 360px`, async ({ page }) => {
  await page.addInitScript((language) => localStorage.setItem("uiLanguage", language), ui.language);
  await base(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/math/subjects/linear-algebra");
  await page.getByRole("button", { name: ui.all, exact: true }).click();
  await expect(page.getByRole("button", { name: ui.start, exact: true })).toBeEnabled();
  await expect(page.getByLabel(ui.count, { exact: true })).toHaveValue("");
  await expect(page.getByText(ui.continuous, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
