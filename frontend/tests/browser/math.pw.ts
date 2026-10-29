import { expect, test } from "@playwright/test";
const chapter = {
  id: "c1",
  number: 1,
  title: "Vector Spaces",
  versionId: "v1",
};
const book = {
  id: "linear",
  subjectId: "linear",
  subjectTitle: "Linear Algebra",
  title: "Linear Algebra",
  language: "en",
  revision: "r1",
  chapters: [chapter],
};
const question = {
  id: "q1",
  chapterId: "c1",
  heading: "Vector space",
  kind: "definition",
  prompt: "Define a vector space over $F$.",
};
function initial() {
  return {
    id: "test",
    book,
    chapterIds: ["c1"],
    sourceVersionIds: ["v1"],
    count: 1,
    kinds: ["definition"],
    difficulty: "standard",
    status: "active",
    questions: [question],
    answers: {},
    draft: "",
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("uiLanguage", "en"));
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        authEnabled: false,
        authenticated: true,
        user: { email: "test@example.com" },
      },
    }),
  );
});
test("chapter selection previews safe math and creates a textbook-language test", async ({
  page,
}) => {
  await page.route("**/api/math/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/books")) return route.fulfill({ json: [book] });
    if (path.endsWith("/chapters/v1"))
      return route.fulfill({
        json: {
          ...chapter,
          bookId: book.id,
          markdown:
            "# Vector space\n$u+v=v+u$\n<script>window.__unsafe=true</script>",
        },
      });
    if (path.endsWith("/tests") && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.chapterIds).toEqual(["c1"]);
      expect(body.kinds).toEqual(["definition", "calculation", "proof"]);
      return route.fulfill({ json: initial() });
    }
    if (path.endsWith("/tests")) return route.fulfill({ json: [] });
    return route.fulfill({ json: initial() });
  });
  await page.goto("/math");
  await page.getByLabel("Textbook").selectOption("linear");
  await page.getByLabel("1. Vector Spaces").check();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".katex").first()).toBeVisible();
  expect(await page.evaluate(() => "__unsafe" in window)).toBe(false);
  await page.getByRole("button", { name: "Create test", exact: true }).click();
  await expect(page).toHaveURL(/\/math\/tests\/test$/);
  await expect(page.getByLabel("Your answer")).toBeVisible();
  await expect(page.getByText("Example solution", { exact: true })).toHaveCount(
    0,
  );
});
test("pause saves draft, resume restores it, grading completes test and review survives reload", async ({
  page,
}) => {
  let state: any = initial();
  await page.route("**/api/math/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      if (path.endsWith("/state")) {
        state = {
          ...state,
          status: body.action === "pause" ? "paused" : "active",
          draft: body.draft,
          version: state.version + 2,
        };
      } else if (path.endsWith("/answer")) {
        state = {
          ...state,
          status: "completed",
          draft: "",
          version: state.version + 2,
          questions: [
            {
              ...question,
              solution: "A set with vector addition and scalar multiplication.",
              rubric: "Vector axioms",
            },
          ],
          answers: {
            q1: {
              text: body.text,
              operationId: body.operationId,
              grade: {
                verdict: "partial",
                feedback: "State the axioms explicitly.",
              },
            },
          },
        };
      }
    }
    return route.fulfill({ json: state });
  });
  await page.goto("/math/tests/test");
  await page.getByLabel("Your answer").fill("A set with operations");
  await page
    .getByRole("button", { name: "Save and pause", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByLabel("Your answer")).toHaveValue(
    "A set with operations",
  );
  await page
    .getByRole("button", { name: "Submit for grading / Retry", exact: true })
    .click();
  await expect(
    page.getByText("Partially correct", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Example solution", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("State the axioms explicitly.", { exact: true }),
  ).toBeVisible();
});
test("math missing session is distinct from a server failure", async ({
  page,
}) => {
  await page.route("**/api/math/tests/missing", (route) =>
    route.fulfill({ status: 404, json: { code: "MATH_TEST_NOT_FOUND" } }),
  );
  await page.goto("/math/tests/missing");
  await expect(page.getByRole("alert")).toContainText("was not found");
  await page.route("**/api/math/tests/unavailable", (route) =>
    route.fulfill({ status: 503, json: { code: "MATH_OPERATION_FAILED" } }),
  );
  await page.goto("/math/tests/unavailable");
  await expect(page.getByRole("alert")).toContainText("could not be completed");
});
