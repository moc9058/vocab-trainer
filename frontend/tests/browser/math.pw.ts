import { expect, test, type Page } from "@playwright/test";
const makeBook = (id: string, title: string) => ({
  id,
  title,
  subjectId: "math",
  subjectTitle: "Mathematics",
  language: "en",
  revision: `${id}-r1`,
  publicationId: `${id}-pub`,
  curriculumRevision: `${id}-curriculum`,
  chapters: [
    { id: "c1", number: 1, title: "Vector Spaces", versionId: `${id}-v1` },
  ],
});
const books = [makeBook("a", "Textbook A"), makeBook("b", "Textbook B")];
function initial() {
  return {
    id: "test",
    book: books[0],
    scopes: [
      { book: books[0], chapterIds: ["c1"], sourceVersionIds: ["a-v1"] },
    ],
    scopeRevision: 0,
    chapterIds: ["c1"],
    sourceVersionIds: ["a-v1"],
    mode: "continuous",
    assessmentVersion: 2,
    phase: "ready",
    generatedCount: 0,
    count: 0,
    stats: { answered: 0, correct: 0, partial: 0, incorrect: 0, revealed: 0 },
    kinds: ["proof"],
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
  options: {
    failNext?: boolean;
    ambiguousReveal?: boolean;
    completed?: boolean;
    conflictScope?: boolean;
  } = {},
) {
  let state: any = initial(),
    created = false,
    nextRequests = 0,
    revealRequests = 0,
    creates = 0,
    records: any[] = [];
  let failNext = options.failNext,
    ambiguousReveal = options.ambiguousReveal;
  await page.route("**/api/math/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/books")) return route.fulfill({ json: books });
    if (path.includes("/chapters/"))
      return route.fulfill({
        json: {
          ...books[0].chapters[0],
          bookId: "a",
          markdown:
            "# Vector space\n\n$u+v=v+u$\n\n<script>window.__unsafe=true</script>",
        },
      });
    if (path.endsWith("/tests") && req.method() === "GET")
      return route.fulfill({
        json: created
          ? [
              {
                id: "test",
                title: state.scopes.map((s: any) => s.book.title).join(" · "),
                status: state.status,
                createdAt: state.createdAt,
              },
            ]
          : [],
      });
    if (path.endsWith("/tests") && req.method() === "POST") {
      creates++;
      created = true;
      const body = req.postDataJSON();
      expect(body.count).toBeUndefined();
      expect(body.scopes.length).toBeGreaterThan(0);
      state = {
        ...state,
        scopes: body.scopes.map((s: any) => ({
          book: books.find((b) => b.id === s.bookId),
          chapterIds: s.chapterIds,
          sourceVersionIds: [`${s.bookId}-v1`],
        })),
      };
      return route.fulfill({ json: state });
    }
    if (path.endsWith("/objectives")) return route.fulfill({ json: [] });
    if (path.endsWith("/questions"))
      return route.fulfill({ json: { items: records, nextCursor: null } });
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      if (path.endsWith("/next")) {
        nextRequests++;
        if (failNext) {
          failNext = false;
          state.version += 2;
          return route.fulfill({
            status: 503,
            json: { code: "MATH_OPERATION_FAILED" },
          });
        }
        if (state.questions[0]) {
          records[records.length - 1] = {
            ...records.at(-1),
            question: state.questions[0],
            answer: state.answers[state.currentQuestionId] ?? {
              text: body.draft ?? "",
              submitted: false,
              operationId: body.operationId,
            },
          };
        }
        const n = state.generatedCount + 1,
          owner = state.scopes[(n - 1) % state.scopes.length].book;
        const q = {
          id: `q${n}`,
          number: n,
          bookId: owner.id,
          bookTitle: owner.title,
          chapterId: "c1",
          chapterTitle: "Vector Spaces",
          heading: "Vector space",
          kind: "proof",
          taskKind: "prove",
          schemaVersion: 2,
          scopeRevision: state.scopeRevision,
          primaryObjectiveId: "vector-space",
          objectiveStatement: "Verify vector-space conditions.",
          difficulty: "standard",
          prompt: `Question ${n}: Prove the stated vector-space identity.`,
          solution: `Solution ${n}: Apply the vector-space axioms.`,
          assistanceStatus: "notReported",
        };
        state = {
          ...state,
          status: "active",
          phase: "question",
          currentQuestionId: q.id,
          generatedCount: n,
          questions: [q],
          answers: {},
          draft: "",
          version: state.version + 2,
        };
        records.push({ question: q, number: n });
      }
      if (path.endsWith("/reveal")) {
        revealRequests++;
        state = {
          ...state,
          phase: "solution",
          draft: body.draft ?? state.draft,
          questions: state.questions.map((q: any) => ({
            ...q,
            revealedAt: new Date().toISOString(),
            assistanceStatus: "viewed",
          })),
          stats: { ...state.stats, revealed: state.stats.revealed + 1 },
          version: state.version + 2,
        };
        records[records.length - 1].question = state.questions[0];
        if (ambiguousReveal) {
          ambiguousReveal = false;
          return route.fulfill({
            status: 503,
            json: { code: "MATH_OPERATION_FAILED" },
          });
        }
      }
      if (path.endsWith("/scope") && options.conflictScope) {
        state = { ...state, draft: "Another tab draft", version: state.version + 2 };
        return route.fulfill({ status: 409, json: { code: "MATH_STALE_VERSION" } });
      }
      if (path.endsWith("/scope"))
        state = {
          ...state,
          scopeRevision: state.scopeRevision + 1,
          scopes: body.scopes.map((s: any) => ({
            book: books.find((b) => b.id === s.bookId),
            chapterIds: s.chapterIds,
            sourceVersionIds: [`${s.bookId}-v1`],
          })),
          draft: body.draft ?? state.draft,
          version: state.version + 2,
        };
      if (path.endsWith("/answer")) {
        const answer = {
          text: body.text,
          operationId: body.operationId,
          grade: {
            verdict: "partial",
            feedback: "Include the zero-vector case.",
          },
        };
        state = {
          ...state,
          phase: "feedback",
          answers: { [body.questionId]: answer },
          draft: "",
          stats: {
            ...state.stats,
            answered: state.stats.answered + 1,
            partial: state.stats.partial + 1,
          },
          version: state.version + 2,
        };
        records[records.length - 1].answer = answer;
      }
      if (path.endsWith("/state"))
        state = {
          ...state,
          status:
            body.action === "finish"
              ? "completed"
              : body.action === "pause"
                ? "paused"
                : state.currentQuestionId
                  ? "active"
                  : "created",
          draft: body.draft ?? "",
          version: state.version + 2,
        };
    }
    return route.fulfill({ json: state });
  });
  return {
    nextRequests: () => nextRequests,
    revealRequests: () => revealRequests,
    creates: () => creates,
  };
}
async function start(page: Page, both = false) {
  await page.goto("/math");
  await page.locator(".math-scope-toggle").filter({ hasText: "Textbook A" }).click();
  await page.getByRole("checkbox", { name: "Select all: Textbook A", exact: true }).check();
  if (both) {
    await page.locator(".math-scope-toggle").filter({ hasText: "Textbook B" }).click();
    await page.getByRole("checkbox", { name: "Select all: Textbook B", exact: true }).check();
  }
  await page
    .getByRole("button", { name: "Start learning", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reveal answer", exact: true }),
  ).toBeVisible();
}
async function menu(page: Page) {
  await page.locator('summary[aria-label="Test menu"]').click();
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
test("selects multiple textbooks with duplicate chapter IDs and keeps one primary action", async ({
  page,
}) => {
  const mock = await mockMath(page);
  await start(page, true);
  await expect(page).toHaveURL(/\/math\/tests\/test$/);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /skip|submit|pause|end test/i }),
  ).toHaveCount(0);
  await expect(page.locator(".math-review-action button")).toHaveCount(1);
  expect(mock.nextRequests()).toBe(1);
  await expect(
    page.getByText("Solution 1: Apply the vector-space axioms.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reveal answer", exact: true })
    .click();
  await expect(
    page.getByText("Solution 1: Apply the vector-space axioms.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(mock.nextRequests()).toBe(1);
  await expect(
    page.getByRole("button", { name: "Next question" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Solution 1: Apply the vector-space axioms.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next question" }).click();
  await expect(
    page.getByText("Question 2: Prove the stated vector-space identity.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Textbook B", { exact: true }).last(),
  ).toBeVisible();
  expect(mock.creates()).toBe(1);
});
test("scope edits preserve the current question and apply to the next", async ({
  page,
}) => {
  await mockMath(page);
  await start(page);
  await menu(page);
  await page
    .getByRole("button", { name: "Change study scope", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".math-scope-toggle").filter({ hasText: "Textbook A" }).click();
  await dialog.locator(".math-scope-toggle").filter({ hasText: "Textbook B" }).click();
  await dialog
    .getByRole("checkbox", { name: "Select all: Textbook A", exact: true })
    .uncheck();
  await dialog
    .getByRole("checkbox", { name: "Select all: Textbook B", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Apply for next question" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".math-tags").getByText("Textbook A", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reveal answer", exact: true })
    .click();
  await page.getByRole("button", { name: "Next question" }).click();
  await expect(
    page.locator(".math-tags").getByText("Textbook B", { exact: true }),
  ).toBeVisible();
  await menu(page);
  await page.getByRole("button", { name: "Answer history" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText(/Question 1 · Textbook A · Answer revealed/),
  ).toBeVisible();
});
test("optional grading lives in the menu, and closing the dialog never discards a draft", async ({
  page,
}) => {
  await mockMath(page);
  await start(page);
  await menu(page);
  await page
    .getByRole("button", { name: "Write an answer / AI grading" })
    .click();
  await page
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill("My proof draft");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reveal answer", exact: true })
    .click();
  await menu(page);
  await page
    .getByRole("button", { name: /Write an answer \/ AI grading/ })
    .click();
  await expect(page.getByRole("textbox")).toHaveValue("My proof draft");
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect(
    page.getByText("Include the zero-vector case.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next question" }),
  ).toBeVisible();
});
test("ambiguous reveal success recovers without revealing twice or advancing", async ({
  page,
}) => {
  const mock = await mockMath(page, { ambiguousReveal: true });
  await start(page);
  await page
    .getByRole("button", { name: "Reveal answer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Next question" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(mock.revealRequests()).toBe(1);
  expect(mock.nextRequests()).toBe(1);
});
test("returning to the library saves and pauses, then resume restores the solution", async ({
  page,
}) => {
  await mockMath(page);
  await start(page);
  await page
    .getByRole("button", { name: "Reveal answer", exact: true })
    .click();
  await page.getByRole("link", { name: /Textbook library/ }).click();
  await expect(page).toHaveURL(/\/math$/);
  await page
    .getByRole("link", { name: /Resume/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByText("Solution 1: Apply the vector-space axioms.", {
      exact: true,
    }),
  ).toBeVisible();
});
test("failed first generation retries without another session or a question count", async ({
  page,
}) => {
  const mock = await mockMath(page, { failNext: true });
  await page.goto("/math");
  await page.locator(".math-scope-toggle").filter({ hasText: "Textbook A" }).click();
  await page.getByRole("checkbox", { name: "Select all: Textbook A", exact: true }).check();
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  await page.getByRole("button", { name: "Start learning" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.locator(".math-review-action button").click();
  await expect(
    page.getByRole("button", { name: "Reveal answer", exact: true }),
  ).toBeVisible();
  expect(mock.creates()).toBe(1);
});
test("safe chapter preview and mobile layout remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockMath(page);
  await page.goto("/math");
  await page.locator(".math-scope-toggle").filter({ hasText: "Textbook A" }).click();
  await page
    .getByRole("button", { name: "Preview: Textbook A / Vector Spaces" })
    .click();
  await expect(page.locator(".katex").first()).toBeVisible();
  expect(await page.evaluate(() => "__unsafe" in window)).toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Select all: Textbook A", exact: true }).check();
  await page.getByRole("button", { name: "Start learning" }).click();
  await expect(
    page.getByRole("button", { name: "Reveal answer", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("missing sessions are distinguished from server errors", async ({
  page,
}) => {
  await page.route("**/api/math/tests/missing", (route) =>
    route.fulfill({ status: 404, json: { code: "MATH_TEST_NOT_FOUND" } }),
  );
  await page.goto("/math/tests/missing");
  await expect(page.getByRole("alert")).toContainText("not found");
});

test("a scope version conflict keeps the local question and optional draft", async ({ page }) => {
  await mockMath(page, { conflictScope: true });
  await start(page);
  await menu(page);
  await page.getByRole("button", { name: "Write an answer / AI grading" }).click();
  await page.getByRole("textbox").fill("Local draft");
  await page.keyboard.press("Escape");
  await menu(page);
  await page.getByRole("button", { name: "Change study scope", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Apply for next question" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Question 1: Prove the stated vector-space identity.", { exact: true })).toBeVisible();
  await menu(page);
  await page.getByRole("button", { name: /Write an answer \/ AI grading/ }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Local draft");
});


test("chapter panels start collapsed and retain independent partial selections", async ({ page }) => {
  const book = {
    ...books[0],
    chapters: [
      ...books[0].chapters,
      { id: "c2", number: 2, title: "Linear Maps", versionId: "a-v2" },
    ],
  };
  await mockMath(page);
  await page.route("**/api/math/books", route => route.fulfill({ json: [book, books[1]] }));
  await page.goto("/math");
  const a = page.locator(".math-scope-book").filter({ hasText: "Textbook A" });
  const b = page.locator(".math-scope-book").filter({ hasText: "Textbook B" });
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start learning" })).toBeDisabled();
  await a.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(a.getByRole("checkbox")).toHaveCount(3);
  await expect(b.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start learning" })).toBeDisabled();
  await a.getByRole("checkbox", { name: "Textbook A / 1. Vector Spaces", exact: true }).check();
  await expect(a.getByRole("checkbox", { name: "Select all: Textbook A", exact: true })).toBeChecked({ indeterminate: true });
  await expect(a.locator("summary")).toContainText("1/2 chapters selected");
  await a.locator("summary").click();
  await b.locator("summary").click();
  await b.getByRole("checkbox", { name: "Select all: Textbook B", exact: true }).check();
  await b.locator("summary").click();
  await expect(page.getByRole("button", { name: "Start learning" })).toBeEnabled();
  await a.locator("summary").click();
  await expect(a.getByRole("checkbox", { name: "Textbook A / 1. Vector Spaces", exact: true })).toBeChecked();
  await expect(a.getByRole("checkbox", { name: "Textbook A / 2. Linear Maps", exact: true })).not.toBeChecked();
  await a.getByRole("checkbox", { name: "Select all: Textbook A", exact: true }).check();
  await expect(a.locator("summary")).toContainText("2/2 chapters selected");
  await a.getByRole("checkbox", { name: "Select all: Textbook A", exact: true }).uncheck();
  await expect(a.locator("summary")).toContainText("0/2 chapters selected");
  await expect(b.locator("summary")).toContainText("1/1 chapters selected");
});
