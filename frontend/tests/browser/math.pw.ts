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
test("Linear Algebra tree confirms only its objective, exposes prerequisites and requires explicit consent", async ({
  page,
}) => {
  await base(page);
  await page.goto("/math/subjects/linear-algebra");
  await page.getByRole("checkbox").filter({ visible: true }).first().check();
  await page
    .getByRole("button", { name: "Preview scope", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Assessed objectives", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Check all three conditions of the subspace criterion.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Required prerequisites", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate questions", exact: true }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: /I confirm the targets/ }).check();
  await expect(
    page.getByRole("button", { name: "Generate questions", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Difficulty", { exact: true }).selectOption("3");
  await expect(
    page.getByRole("heading", { name: "Confirm this test’s scope" }),
  ).toHaveCount(0);
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
