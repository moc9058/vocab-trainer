import { mathHash, sourceScope, MATH_INPUT_BYTES } from "./math-core.js";
import { db } from "./firestore.js";
import { loadMathCurriculum } from "./math-publication.js";
import type {
  MathBook,
  MathScope,
  MathScopeInput,
  MathTest,
  MathQuestion,
  TaskKind,
} from "./math-types.js";
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
export function activeMathScopes(test: MathTest): MathScope[] {
  return (
    test.scopes ?? [
      {
        book: test.book,
        chapterIds: test.chapterIds,
        sourceVersionIds: test.sourceVersionIds,
      },
    ]
  );
}
export function scopeKey(bookId: string, id: string): string {
  return mathHash(JSON.stringify([bookId, id]));
}
export function orderedMathScopes(test: MathTest): MathScope[] {
  const scopes = activeMathScopes(test);
  if (test.pendingBookId) {
    const saved = scopes.find((s) => s.book.id === test.pendingBookId);
    if (saved) return [saved];
  }
  return [...scopes].sort((a, b) => {
    const difference =
      (test.scopeBookCounts?.[a.book.id] ?? 0) -
      (test.scopeBookCounts?.[b.book.id] ?? 0);
    return (
      difference ||
      mathHash(`${test.lock?.token}:${a.book.id}`).localeCompare(
        mathHash(`${test.lock?.token}:${b.book.id}`),
      )
    );
  });
}
export function scopeContext(test: MathTest, scope: MathScope): MathTest {
  const { scopes: _scopes, ...rest } = test;
  const context: MathTest = {
    ...rest,
    book: scope.book,
    chapterIds: scope.chapterIds,
    sourceVersionIds: scope.sourceVersionIds,
    taskKinds: test.taskKinds ?? ["prove", "determine", "compute", "derive"],
    count: 1,
    mode: "continuous",
    chapterExposure: Object.fromEntries(
      scope.chapterIds.map((id) => [
        id,
        test.scopeChapterCounts?.[scopeKey(scope.book.id, id)] ?? 0,
      ]),
    ),
  };
  if (scope.book.publicationId) {
    context.assessmentVersion = 2;
    context.publicationId = scope.book.publicationId;
    context.curriculumRevision = scope.book.curriculumRevision;
  } else {
    delete context.assessmentVersion;
    delete context.publicationId;
    delete context.curriculumRevision;
  }
  return context;
}
export async function questionMathContext(
  test: MathTest,
  q: MathQuestion,
): Promise<MathTest> {
  if (!q.bookId)
    return scopeContext(test, {
      book: test.book,
      chapterIds: test.chapterIds,
      sourceVersionIds: test.sourceVersionIds,
    });
  let scopes = activeMathScopes(test);
  if (q.scopeRevision !== (test.scopeRevision ?? 0)) {
    const doc = await db
      .collection("math_tests")
      .doc(test.id)
      .collection("scopes")
      .doc(String(q.scopeRevision))
      .get();
    if (!doc.exists) return fail(409, "MATH_SCOPE_MISSING");
    scopes = doc.get("scopes");
  }
  const owner = scopes.find((s) => s.book.id === q.bookId);
  if (
    !owner ||
    (q.publicationId && q.publicationId !== owner.book.publicationId)
  )
    return fail(409, "MATH_SOURCE_MISSING");
  return scopeContext(test, owner);
}
export async function prepareMathScopes(
  inputs: MathScopeInput[],
  test?: MathTest,
  taskKinds?: TaskKind[],
): Promise<MathScope[]> {
  if (
    !inputs.length ||
    inputs.length > 100 ||
    new Set(inputs.map((s) => s.bookId)).size !== inputs.length ||
    inputs.reduce((n, s) => n + s.chapterIds.length, 0) > 100
  )
    return fail(400, "MATH_INVALID_SCOPE");
  const result: MathScope[] = [];
  for (const input of inputs) {
    let book: MathBook | undefined;
    if (test) {
      const pin = await db
        .collection("math_tests")
        .doc(test.id)
        .collection("bookPins")
        .doc(input.bookId)
        .get();
      book = pin.get("book");
      if (book && !book.publicationId) book = undefined;
      if (!book)
        book = activeMathScopes(test).find(
          (s) => s.book.id === input.bookId && s.book.publicationId,
        )?.book;
    }
    if (!book) {
      const doc = await db.collection("math_books").doc(input.bookId).get();
      if (!doc.exists) return fail(404, "MATH_BOOK_NOT_FOUND");
      book = doc.data() as MathBook;
    }
    if (!book.publicationId) return fail(422, "MATH_CURRICULUM_UNAVAILABLE");
    const curriculum = await loadMathCurriculum(db, book);
    let sourceVersionIds: string[];
    try {
      sourceVersionIds = sourceScope(book, input.chapterIds);
    } catch {
      return fail(400, "MATH_INVALID_SCOPE");
    }
    const selected = book.chapters
      .filter((c) => input.chapterIds.includes(c.id))
      .map((c) => c.id);
    if (
      !curriculum.objectives.some(
        (o) =>
          o.status === "active" &&
          selected.includes(o.chapterId) &&
          o.supportedTaskKinds.some((k) =>
            (
              taskKinds ?? test?.taskKinds ?? ["prove", "determine", "compute", "derive"]
            ).includes(k),
          ),
      )
    )
      return fail(422, "MATH_NO_FEASIBLE_OBJECTIVE");
    const docs = await db.getAll(
      ...sourceVersionIds.map((id) =>
        db.collection("math_chapter_versions").doc(id),
      ),
    );
    if (
      Buffer.byteLength(JSON.stringify(docs.map((d) => d.data()))) >
      MATH_INPUT_BYTES - 10000
    )
      return fail(413, "MATH_SCOPE_TOO_LARGE");
    result.push({ book, chapterIds: selected, sourceVersionIds });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 400000)
    return fail(413, "MATH_SCOPE_TOO_LARGE");
  return result;
}
