import { expect, test, type Page } from "@playwright/test";
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
const question = (n = 1) => ({
  id: `q${n}`,
  number: n,
  chapterId: "c1",
  heading: "Vector space",
  kind: "definition",
  prompt: `Question ${n}: Define a vector space over $F$.`,
});
function initial() {
  return {
    id: "test",
    book,
    chapterIds: ["c1"],
    sourceVersionIds: ["v1"],
    count: 0,
    mode: "continuous",
    phase: "ready",
    generatedCount: 0,
    stats: { answered: 0, correct: 0, partial: 0, incorrect: 0 },
    kinds: ["definition"],
    difficulty: "standard",
    status: "created",
    questions: [],
    answers: {},
    draft: "",
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
async function mockMath(
  page: Page,
  options: { failNext?: boolean; legacy?: boolean; v2?: boolean } = {},
) {
  let state: any = initial();
  if (options.v2)
    state = {
      ...state,
      assessmentVersion: 2,
      taskKinds: ["prove", "determine", "compute", "derive"],
      publicationId: "pub",
      curriculumRevision: "rev",
      book: { ...book, publicationId: "pub" },
    };
  let nextRequests = 0;
  let failNext = options.failNext ?? false;
  let records: any[] = [];
  if (options.legacy) {
    state = {
      ...state,
      mode: undefined,
      phase: undefined,
      count: 1,
      status: "active",
      questions: [question()],
    };
  }
  await page.route("**/api/math/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path.endsWith("/books")) return route.fulfill({ json: [state.book] });
    if (path.endsWith("/chapters/v1"))
      return route.fulfill({
        json: {
          ...chapter,
          bookId: book.id,
          markdown:
            "# Vector space\n\n$u+v=v+u$\n\n- Closure\n- Zero\n<script>window.__unsafe=true</script>",
        },
      });
    if (path.endsWith("/tests") && req.method() === "GET")
      return route.fulfill({ json: [] });
    if (path.endsWith("/tests") && req.method() === "POST") {
      const body = req.postDataJSON();
      if (options.v2) {
        expect(body.assessmentVersion).toBe(2);
        expect(body.taskKinds).toEqual([
          "prove",
          "determine",
          "compute",
          "derive",
        ]);
        expect(body.kinds).toBeUndefined();
      }
      expect(body.mode).toBe("continuous");
      expect(body.count).toBeUndefined();
      expect(body.chapterIds).toEqual(["c1"]);
      return route.fulfill({ json: state });
    }
    if (path.endsWith("/objectives"))
      return route.fulfill({
        json: [
          {
            objectiveId: "la-vector-space-axioms",
            submitted: 0,
            correct: 0,
            partial: 0,
            incorrect: 0,
            skipped: 0,
          },
        ],
      });
    if (path.endsWith("/questions"))
      return route.fulfill({
        json: {
          items: records.map((item: any) =>
            state.status === "completed"
              ? {
                  ...item,
                  question: {
                    ...item.question,
                    solution: "A vector space satisfies the axioms.",
                  },
                }
              : item,
          ),
          nextCursor: null,
        },
      });
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      if (path.endsWith("/next")) {
        nextRequests++;
        if (failNext) {
          failNext = false;
          state = { ...state, status: "active", version: state.version + 2 };
          return route.fulfill({
            status: 503,
            json: { code: "MATH_OPERATION_FAILED" },
          });
        }
        if (state.phase === "question" && records.length) {
          records[records.length - 1] = {
            ...records[records.length - 1],
            answer: {
              text: body.draft ?? "",
              submitted: false,
              operationId: body.operationId,
            },
          };
        }
        const number = state.generatedCount + 1;
        const q = {
          ...question(number),
          ...(options.v2
            ? {
                schemaVersion: 2,
                primaryObjectiveId: "la-vector-space-axioms",
                objectiveStatement: "Determine vector-space conditions.",
                taskKind: "determine",
                difficulty: "standard",
                sourceRefs: [{ chapterId: "c1", heading: "Vector space" }],
                solution: "A vector space satisfies the axioms.",
                assistanceStatus: "notReported",
              }
            : {}),
        };
        state = {
          ...state,
          status: "active",
          phase: "question",
          currentQuestionId: q.id,
          generatedCount: number,
          questions: [q],
          answers: {},
          draft: "",
          version: state.version + 2,
        };
        records.push({ question: q, number });
      }
      if (path.endsWith("/answer")) {
        const q = {
          ...state.questions[0],
          solution: "A vector space satisfies the axioms.",
          rubric: "Vector axioms",
        };
        const answer = {
          text: body.text,
          operationId: body.operationId,
          grade: {
            verdict: "partial",
            feedback: "State the axioms explicitly.",
          },
        };
        state = {
          ...state,
          status: options.legacy ? "completed" : "active",
          phase: "feedback",
          draft: "",
          version: state.version + 2,
          questions: [q],
          answers: { [q.id]: answer },
          stats: {
            answered: state.stats.answered + 1,
            correct: 0,
            partial: state.stats.partial + 1,
            incorrect: 0,
          },
        };
        if (options.legacy) records = [{ question: q, answer, number: 1 }];
        else
          records[records.length - 1] = {
            question: q,
            answer,
            number: q.number,
          };
      }
      if (path.endsWith("/assistance")) {
        state = {
          ...state,
          questions: state.questions.map((q: any) => ({
            ...q,
            assistanceStatus: "viewed",
          })),
          version: state.version + 2,
        };
      }
      if (path.endsWith("/state")) {
        state = {
          ...state,
          status:
            body.action === "pause"
              ? "paused"
              : body.action === "finish"
                ? "completed"
                : "active",
          draft: body.draft ?? "",
          version: state.version + 2,
        };
        if (body.action === "finish" && state.phase === "question")
          records[records.length - 1] = {
            ...records[records.length - 1],
            answer: {
              text: body.draft,
              submitted: false,
              operationId: body.operationId,
            },
          };
      }
    }
    return route.fulfill({ json: state });
  });
  return { nextRequests: () => nextRequests };
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
test("one textbook auto-selects, no question count, accessible safe preview and automatic first question", async ({
  page,
}) => {
  const mock = await mockMath(page);
  await page.goto("/math");
  await expect(page.getByLabel("Textbook", { exact: true })).toHaveValue(
    "linear",
  );
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Preview: Vector Spaces" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".katex").first()).toBeVisible();
  expect(await page.evaluate(() => "__unsafe" in window)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview: Vector Spaces" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Start learning" }).click();
  await expect(page).toHaveURL(/\/math\/tests\/test$/);
  await expect(page.getByLabel("Your answer", { exact: true })).toBeVisible();
  expect(mock.nextRequests()).toBe(1);
  await expect(page.getByText("Example solution", { exact: true })).toHaveCount(
    0,
  );
});
test("feedback stays until next; pause and reload restore draft; explicit finish opens review", async ({
  page,
}) => {
  const mock = await mockMath(page);
  await page.goto("/math");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Start learning" }).click();
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("A set with operations");
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Partially correct", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveCount(0);
  expect(mock.nextRequests()).toBe(1);
  await page.reload();
  await expect(
    page.getByText("State the axioms explicitly.", { exact: true }),
  ).toBeVisible();
  expect(mock.nextRequests()).toBe(1);
  await page
    .getByRole("button", { name: "Next question", exact: false })
    .click();
  await expect(page.getByLabel("Your answer", { exact: true })).toBeVisible();
  expect(mock.nextRequests()).toBe(2);
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("An unfinished proof");
  await page
    .getByRole("button", { name: "Save and pause", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Resume", exact: false }).click();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue(
    "An unfinished proof",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "End test", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your learning, saved." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review answers", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator(".math-review-item summary").last().click();
  await expect(
    page.getByText("An unfinished proof", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".math-review-item")
      .last()
      .getByText("Example solution", { exact: true }),
  ).toBeVisible();
});
test("skip moves to the next question and keeps its draft in history", async ({
  page,
}) => {
  await mockMath(page);
  await page.goto("/math");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Start learning" }).click();
  await page.getByLabel("Your answer", { exact: true }).fill("Partial work");
  await page
    .getByRole("button", { name: "Skip without answering", exact: false })
    .click();
  await expect(page.getByText("Question 2:", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: "Answer history", exact: false })
    .click();
  await page.locator(".math-review-item summary").first().click();
  await expect(page.getByText("Partial work", { exact: true })).toBeVisible();
  await expect(page.getByText("Not submitted", { exact: false })).toBeVisible();
});
test("failed initial generation retries without another session or an input count", async ({
  page,
}) => {
  const mock = await mockMath(page, { failNext: true });
  await page.goto("/math");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Start learning" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Your answer", { exact: true })).toBeVisible();
  expect(mock.nextRequests()).toBe(2);
});
test("legacy fixed-count session still finishes and supports historical review", async ({
  page,
}) => {
  await mockMath(page, { legacy: true });
  await page.goto("/math/tests/test");
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("A set with operations");
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your learning, saved." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review answers", exact: true })
    .click();
  await page.locator(".math-review-item summary").click();
  await expect(
    page.getByText("State the axioms explicitly.", { exact: true }),
  ).toBeVisible();
});
test("math missing session is distinct from server failure", async ({
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
test("mobile layout has no horizontal overflow and actions remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockMath(page);
  await page.goto("/math");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Start learning" }).click();
  await page.getByLabel("Your answer", { exact: true }).fill("A vector space");
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Next question", exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("v2 displays objectives and four task settings; solution assistance keeps the unsaved answer", async ({
  page,
}) => {
  await mockMath(page, { v2: true });
  await page.goto("/math");
  await page.getByText("Question settings", { exact: true }).click();
  for (const label of [
    "Proof",
    "Justified determination",
    "Computation",
    "Derivation",
  ])
    await expect(
      page.getByRole("checkbox", { name: label, exact: true }),
    ).toBeChecked();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Start learning" }).click();
  await expect(
    page.getByText("Learning objective: Determine vector-space conditions."),
  ).toBeVisible();
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("My unsaved reasoning");
  const assistance = page.waitForRequest((r) =>
    r.url().endsWith("/assistance"),
  );
  await page.getByText("Example solution", { exact: true }).click();
  expect((await assistance).postDataJSON().kind).toBe("solution_view");
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue(
    "My unsaved reasoning",
  );
  await page
    .getByText("Practice records by objective", { exact: true })
    .click();
  await expect(
    page.getByText(
      "These are shared workspace practice records, not a certification of individual mastery.",
    ),
  ).toBeVisible();
});
