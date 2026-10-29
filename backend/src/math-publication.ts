import type { Firestore } from "@google-cloud/firestore";
import { mathHash } from "./math-core.js";
import { canonical } from "./math-curriculum.js";
import type { Curriculum, MathBook, MathSource } from "./math-types.js";
export async function publishMathBook(
  db: Firestore,
  book: MathBook,
  sources: MathSource[],
  curriculum: Curriculum | undefined,
  dryRun: boolean,
): Promise<void> {
  const ref = db.collection("math_books").doc(book.id),
    old = await ref.get();
  const retained = (old.get("chapters") ?? []).filter(
    (c: { id: string }) => !book.chapters.some((n) => n.id === c.id),
  );
  if (retained.length && curriculum)
    throw new Error(
      "Retained chapters have no matching catalog: restore their manifest entries before v2 publication",
    );
  if (retained.length) {
    book.chapters = [...book.chapters, ...retained].sort(
      (a, b) => a.number - b.number,
    );
    if (
      new Set(book.chapters.map((c) => c.number)).size !== book.chapters.length
    )
      throw new Error("Chapter number conflicts with retained chapters");
    const { revision: _, ...content } = book;
    book.revision = mathHash(canonical(content));
  }
  console.log(
    `${book.id}: ${sources.filter((s) => !(old.get("chapters") ?? []).some((c: { versionId: string }) => c.versionId === s.versionId)).length} changed chapters; ${curriculum?.objectives.length ?? 0} objectives; publication ${book.publicationId ?? book.revision}; ${dryRun ? "dry run" : "publish"}`,
  );
  if (dryRun) return;
  // Content-addressed documents are immutable, including retries after partial failure.
  const immutable = async (collection: string, id: string, data: object) => {
    const target = db.collection(collection).doc(id);
    await db.runTransaction(async (tx) => {
      const saved = await tx.get(target);
      if (saved.exists) {
        if (canonical(saved.data()) !== canonical(data))
          throw new Error(`Immutable document conflict: ${collection}/${id}`);
      } else tx.create(target, data);
    });
  };
  for (const source of sources)
    await immutable("math_chapter_versions", source.versionId, source);
  if (curriculum) {
    for (const objective of curriculum.objectives)
      await immutable(
        `math_curriculum_versions/${curriculum.revision}/objectives`,
        objective.id,
        objective,
      );
    const { objectives, ...meta } = curriculum;
    await immutable("math_curriculum_versions", curriculum.revision, {
      ...meta,
      objectiveIds: objectives.map((o) => o.id),
    });
    // All writes above have been read or created and verified before marking complete.
    await immutable("math_publications", book.publicationId!, {
      book,
      curriculumRevision: curriculum.revision,
      subjectProfileVersion: book.subjectProfile!.version,
      status: "complete",
    });
  }
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (current.get("revision") !== old.get("revision"))
      throw new Error("Publication changed concurrently; run sync again");
    tx.set(ref, book);
  });
}
export async function loadMathCurriculum(
  db: Firestore,
  book: MathBook,
): Promise<Curriculum> {
  const fail = (): never => {
    throw Object.assign(new Error("MATH_CURRICULUM_MISSING"), {
      statusCode: 409,
    });
  };
  if (!book.publicationId || !book.curriculumRevision) return fail();
  const pub = await db
    .collection("math_publications")
    .doc(book.publicationId)
    .get();
  if (
    pub.get("status") !== "complete" ||
    canonical(pub.get("book")) !== canonical(book)
  )
    return fail();
  const ref = db
      .collection("math_curriculum_versions")
      .doc(book.curriculumRevision),
    meta = await ref.get();
  if (!meta.exists || meta.get("bookId") !== book.id) return fail();
  const ids = meta.get("objectiveIds") as string[];
  if (!Array.isArray(ids) || !ids.length) return fail();
  const docs = await db.getAll(
    ...ids.map((id) => ref.collection("objectives").doc(id)),
  );
  if (docs.some((d) => !d.exists)) return fail();
  const { objectiveIds: _, ...data } = meta.data()!;
  const curriculum = {
    ...data,
    objectives: docs.map((d) => d.data()),
  } as Curriculum;
  const { curriculumRevision } = await import("./math-curriculum.js");
  if (curriculumRevision(curriculum) !== book.curriculumRevision) return fail();
  const sources = await db.getAll(
    ...book.chapters.map((c) =>
      db.collection("math_chapter_versions").doc(c.versionId),
    ),
  );
  if (
    sources.some(
      (doc, i) =>
        !doc.exists ||
        doc.get("bookId") !== book.id ||
        doc.get("id") !== book.chapters[i].id ||
        doc.get("versionId") !== book.chapters[i].versionId ||
        mathHash(doc.get("markdown") ?? "") !==
          curriculum.sources.find((s) => s.chapterId === book.chapters[i].id)
            ?.sha256,
    )
  )
    return fail();
  return curriculum;
}
