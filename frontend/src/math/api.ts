import { fetchJson, postJson, putJson, ApiError } from "../api/client";
import { enqueueAnswer } from "../utils/answerOutbox";
import type {
  Catalog,
  Subject,
  CurriculumNode,
  Concept,
  Unit,
  FoundationProfile,
  ScopeRequest,
  ScopePreview,
  MathTest,
  TestView,
  StoredSolution,
} from "./types";
export const mathApi = {
  catalog: () =>
    fetchJson<{
      activeCatalogId: string | null;
      subjects: Subject[];
      capabilities: { generate: boolean };
    }>("/api/math/catalog"),
  nodes: (catalogId: string, subjectId: string, cursor?: string) =>
    fetchJson<{ items: CurriculumNode[]; nextCursor: string | null }>(
      `/api/math/catalogs/${catalogId}/nodes?subjectId=${subjectId}${cursor ? `&cursor=${cursor}` : ""}`,
    ),
  concept: (catalogId: string, id: string) =>
    fetchJson<Concept>(`/api/math/catalogs/${catalogId}/concepts/${id}`),
  learningState: (id: string) =>
    fetchJson<{
      state: {
        selfDeclaredReadiness: "known" | "needs-review" | "unknown";
        revision: number;
      } | null;
      items: {
        objectiveId: string;
        demonstrated: boolean;
        valid: boolean;
        conceptRevisionId: string;
      }[];
    }>(`/api/math/learning-states/${id}`),
  readiness: (
    catalogId: string,
    conceptId: string,
    readiness: "known" | "needs-review" | "unknown",
    expectedRevision: number,
  ) =>
    putJson(`/api/math/learning-states/${conceptId}`, {
      catalogId,
      readiness,
      expectedRevision,
      operationId: crypto.randomUUID(),
    }),
  unit: (catalogId: string, id: string) =>
    fetchJson<Unit>(`/api/math/catalogs/${catalogId}/units/${id}`),
  profiles: (catalogId: string) =>
    fetchJson<{
      profiles: (FoundationProfile & {
        capabilitiesHash: string;
        acceptance: unknown;
      })[];
    }>(`/api/math/foundation-profiles?catalogId=${catalogId}`),
  preview: (request: ScopeRequest) =>
    postJson<ScopePreview>("/api/math/scope-previews", request),
  create: (preview: ScopePreview) =>
    postJson<{ testId: string; jobId: string }>("/api/math/tests", {
      previewId: preview.id,
      scopeHash: preview.scopeHash,
      acceptance: preview.requiredAcceptance,
      operationId: `create-${preview.id}`,
    }),
  tests: (subjectId?: string, cursor?: string) =>
    fetchJson<{ items: MathTest[]; nextCursor: string | null }>(
      `/api/math/tests?${new URLSearchParams({ ...(subjectId ? { subjectId } : {}), ...(cursor ? { cursor } : {}) })}`,
    ),
  test: async (id: string) => {
    const view = await fetchJson<TestView>(`/api/math/tests/${id}`);
    if (
      !(pendingByTest.get(id) ?? 0) &&
      (!revisions.has(id) || view.revision >= revisions.get(id)!.test)
    ) {
      const prior = revisions.get(id);
      seedRevisions(view);
      if (prior) {
        const next = revisions.get(id)!;
        for (const [key, revision] of Object.entries(prior.drafts))
          next.drafts[key] = Math.max(next.drafts[key] ?? 0, revision);
        for (const [key, version] of Object.entries(prior.grades))
          next.grades[key] = Math.max(next.grades[key] ?? 0, version);
        next.review = Math.max(next.review, prior.review);
      }
    }
    return view;
  },
  report: (
    testId: string,
    questionId: string,
    reason: string,
    details: string,
  ) =>
    postJson("/api/math/problem-reports", {
      testId,
      questionId,
      reason,
      details,
      operationId: crypto.randomUUID(),
    }),
  job: (id: string) =>
    fetchJson<{
      state: string;
      lastError: string | null;
      cursor: number;
      stage: string;
      calls: number;
      tokens: number;
    }>(`/api/math/jobs/${id}`),
  scope: (id: string, cursor?: string) =>
    fetchJson<{
      items: { role: string; ref: { conceptId: string; capability: string } }[];
      nextCursor: string | null;
    }>(`/api/math/tests/${id}/scope${cursor ? `?cursor=${cursor}` : ""}`),
};
const pendingByTest = new Map<string, number>();
const revisions = new Map<
  string,
  {
    test: number;
    drafts: Record<string, number>;
    review: number;
    grades: Record<string, number>;
  }
>();
function seedRevisions(view: TestView) {
  revisions.set(view.id, {
    test: view.revision,
    drafts: Object.fromEntries(
      view.drafts.map((d) => [d.questionId, d.revision]),
    ),
    review: view.sitting?.review.revision ?? 0,
    grades: Object.fromEntries(
      view.attempts.map((a) => [a.id, a.gradeVersion]),
    ),
  });
}
/** Freezes the payload at the first send. A lost acknowledgement resends it byte for byte. */
export function queueMathOperation(
  testId: string,
  action: string,
  input: Record<string, unknown> = {},
  options: {
    method?: "POST" | "PUT";
    questionId?: string;
    attemptId?: string;
  } = {},
): Promise<Record<string, any>> {
  pendingByTest.set(testId, (pendingByTest.get(testId) ?? 0) + 1);
  const settled = () =>
    pendingByTest.set(
      testId,
      Math.max(0, (pendingByTest.get(testId) ?? 1) - 1),
    );
  let frozen: Record<string, unknown> | null = null;
  const suffix =
    action === "draft"
      ? `drafts/${options.questionId}`
      : action === "assessment" || action === "retry-grade"
        ? `attempts/${options.attemptId}/${action}`
        : action === "invalidate"
          ? `questions/${options.questionId}/invalidate`
          : action;
  const prepare = async () => {
    if (!revisions.has(testId))
      seedRevisions(await fetchJson<TestView>(`/api/math/tests/${testId}`));
    const version = revisions.get(testId)!;
    frozen = {
      ...input,
      operationId: crypto.randomUUID(),
      ...(action === "draft"
        ? { expectedDraftRevision: version.drafts[options.questionId!] ?? 0 }
        : action === "review"
          ? { reviewRevision: version.review }
          : action === "assessment" || action === "retry-grade"
            ? { expectedGradeVersion: version.grades[options.attemptId!] ?? 0 }
            : { expectedRevision: version.test }),
    };
  };
  return new Promise((resolve, reject) =>
    enqueueAnswer({
      domain: "math",
      execute: async () => {
        if (!frozen) await prepare();
        const result = await (
          options.method === "PUT" ||
            action === "draft" ||
            action === "assessment"
            ? putJson
            : postJson
        )<Record<string, any>>(`/api/math/tests/${testId}/${suffix}`, frozen);
        const version = revisions.get(testId)!;
        if (typeof result.revision === "number") version.test = result.revision;
        if (result.draft)
          version.drafts[options.questionId!] = result.draft.revision;
        if (result.review) version.review = result.review.revision;
        if (typeof result.gradeVersion === "number")
          version.grades[options.attemptId!] = result.gradeVersion;
        return result;
      },
      rebase: async () => {
        const view = await fetchJson<TestView>(`/api/math/tests/${testId}`);
        seedRevisions(view);
        await prepare();
      },
      resolve: (result) => {
        settled();
        resolve(result as Record<string, any>);
      },
      onDiscard: settled,
      reject,
    }),
  );
}
export function refreshMathRevisions(view: TestView) {
  seedRevisions(view);
}
