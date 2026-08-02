import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getFilteredWords,
  getWordProgress,
  updateWordProgress,
  getProgressForLanguage,
  flagWord,
  getWordGroup,
  getWordsByIds,
  getAllGrammarItems,
  getGrammarItemsByIds,
  getGrammarGroup,
  getGrammarComponentProgress,
  updateGrammarComponentProgress,
  getGrammarProgressForLanguage,
  getCombinedQuizSession,
  saveCombinedQuizSession,
} from "../firestore.js";
import type {
  CombinedQuizQuestion,
  CombinedQuizSession,
  CombinedQuizWordQuestion,
  CombinedQuizGrammarQuestion,
  MixWeightConfig,
  Grammar,
  Word,
  WordProgress,
} from "../types.js";
import { shuffle, weightedInterleave, weightedMerge, insertRetryQuestion, isMastered } from "../quiz-utils.js";

interface WordFilterBody {
  topics?: string[];
  categories?: string[];
  levels?: string[];
  groupIds?: string[];
  groupWeights?: Record<string, number>;
  flaggedOnly?: boolean;
  /**
   * An explicit pool, bypassing every other word filter. The caller has already decided
   * which words belong — the article quizzes resolve that client-side, where the import
   * sessions' entity ids and the group documents both already are — so this reads the ids
   * directly instead of scanning the language's whole word collection. Cheaper than the
   * filter path, not more expensive. An EMPTY array means an empty pool, not "everything".
   */
  wordIds?: string[];
}

/**
 * JSON schema for `MixWeightConfig`. The server treats it as opaque UI state — it is stored
 * and echoed back, never read for ordering (see the type's doc comment) — but it is still
 * validated so a malformed shape can't be written into a session document.
 */
const MIX_WEIGHTS_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "object",
      properties: { A: { type: "number", minimum: 0 }, B: { type: "number", minimum: 0 } },
    },
    domain: {
      type: "object",
      properties: {
        A: {
          type: "object",
          properties: { word: { type: "number", minimum: 0 }, grammar: { type: "number", minimum: 0 } },
        },
        B: {
          type: "object",
          properties: { word: { type: "number", minimum: 0 }, grammar: { type: "number", minimum: 0 } },
        },
      },
    },
  },
} as const;

interface GrammarFilterBody {
  groupIds?: string[];
  groupWeights?: Record<string, number>;
  /** Explicit grammar pool — the `wordIds` counterpart. */
  grammarIds?: string[];
}

/**
 * The combined quiz and the Group B quiz are the SAME routes over the same
 * `combined_quiz_sessions` collection, differing only in the Firestore doc key —
 * so both can be in progress for one language at the same time. Everything else
 * (weighted ordering, retry re-queue, mid-session weight changes) is inherited
 * unchanged.
 */
function makeCombinedQuizRoutes(opts: { sessionKey: (language: string) => string }): FastifyPluginAsync {
  return async (fastify) => {
  // Start a combined session: each domain is ordered internally by group weights
  // (words exactly like /api/quiz, grammar analogously), then the two streams are
  // merged by the word/grammar domain weights.
  fastify.post<{
    Body: {
      language: string;
      domainWeights?: { word?: number; grammar?: number };
      mixWeights?: MixWeightConfig;
      correctWeight?: number;
      randomOrder?: boolean;
      word?: WordFilterBody;
      grammar?: GrammarFilterBody;
    };
  }>(
    "/start",
    {
      schema: {
        body: {
          type: "object",
          required: ["language"],
          properties: {
            language: { type: "string" },
            domainWeights: {
              type: "object",
              properties: {
                word: { type: "number", minimum: 0 },
                grammar: { type: "number", minimum: 0 },
              },
            },
            mixWeights: MIX_WEIGHTS_SCHEMA,
            correctWeight: { type: "number", minimum: 0 },
            randomOrder: { type: "boolean" },
            word: {
              type: "object",
              properties: {
                topics: { type: "array", items: { type: "string" } },
                categories: { type: "array", items: { type: "string" } },
                levels: { type: "array", items: { type: "string" } },
                groupIds: { type: "array", items: { type: "string" } },
                groupWeights: { type: "object", additionalProperties: { type: "number" } },
                flaggedOnly: { type: "boolean" },
                wordIds: { type: "array", items: { type: "string" } },
              },
            },
            grammar: {
              type: "object",
              properties: {
                groupIds: { type: "array", items: { type: "string" } },
                groupWeights: { type: "object", additionalProperties: { type: "number" } },
                grammarIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, domainWeights, mixWeights, correctWeight, randomOrder, word, grammar } =
        request.body;
      const wordWeight = Math.max(0, domainWeights?.word ?? 1);
      const grammarWeight = Math.max(0, domainWeights?.grammar ?? 1);
      const useCorrect = correctWeight !== undefined;
      if (wordWeight <= 0 && grammarWeight <= 0 && (correctWeight ?? 0) <= 0) {
        return reply.badRequest("At least one of the word/grammar/already-correct weights must be positive");
      }

      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      const toWordQuestion = (w: Word): CombinedQuizWordQuestion => ({
        kind: "word",
        wordId: w.id,
        term: w.term,
        definitions: w.definitions,
        transliteration: w.transliteration,
        examples: w.examples,
        ...(w.hanjaReadings ? { hanjaReadings: w.hanjaReadings } : {}),
      });
      const toGrammarQuestion = (item: Grammar): CombinedQuizGrammarQuestion => ({
        kind: "grammar",
        grammarId: item.id,
        statement: item.statement,
      });

      // Load long-term progress only when partitioning mastered items into their own bucket.
      const [wordProgress, grammarProgress] = useCorrect
        ? await Promise.all([getProgressForLanguage(language), getGrammarProgressForLanguage(language)])
        : [null, null];

      // --- Word side: mirror /api/quiz/start ordering (fresh pool only when partitioning) ---
      let wordQuestions: CombinedQuizWordQuestion[] = [];
      let wordGroupMembership: Record<string, string[]> | undefined;
      let knownWordItems: Word[] = [];
      if (wordWeight > 0 || useCorrect) {
        // An explicit id list IS the pool — reading those docs directly skips the
        // whole-collection scan `getFilteredWords` does. Ids with no document (the word was
        // deleted since the caller built the list) simply drop out rather than erroring.
        const pool = word?.wordIds
          ? await getWordsByIds(word.wordIds)
          : await getFilteredWords(language, {
              topics: word?.topics,
              categories: word?.categories,
              levels: word?.levels,
              groupIds: word?.groupIds,
              flaggedOnly: word?.flaggedOnly,
            });
        let freshPool = pool;
        if (useCorrect) {
          knownWordItems = pool.filter((w) => isMastered(wordProgress!.words[w.id]));
          freshPool = pool.filter((w) => !isMastered(wordProgress!.words[w.id]));
        }
        if (wordWeight > 0) {
          let ordered: Word[];
          if (word?.groupIds && word.groupIds.length > 0) {
            const membership = await buildWordMembership(word.groupIds, freshPool);
            ordered = weightedInterleave(
              word.groupIds.map((id) => ({
                weight: word.groupWeights?.[id] ?? 1,
                items: membership[id] ?? [],
              }))
            );
            wordGroupMembership = Object.fromEntries(
              Object.entries(membership).map(([id, ws]) => [id, ws.map((w) => w.id)])
            );
          } else {
            ordered = shuffle(freshPool);
          }
          wordQuestions = ordered.map(toWordQuestion);
        }
      }

      // --- Grammar side: group-weighted like the word side (grammar groups gain weights here) ---
      let grammarQuestions: CombinedQuizGrammarQuestion[] = [];
      let grammarGroupMembership: Record<string, string[]> | undefined;
      let knownGrammarItems: Grammar[] = [];
      if (grammarWeight > 0 || useCorrect) {
        // Scope the pool to the selected groups BEFORE the mastered split, mirroring the word
        // side (whose `getFilteredWords(groupIds)` already did it) and routes/grammar-quiz.ts.
        // Without it the "already-correct" bucket draws mastered grammar from groups the user
        // never selected. The group docs are fetched once here and reused for the membership
        // build below, so this costs no extra reads.
        const scopedGroupIds = grammar?.groupIds?.length ? grammar.groupIds : null;
        // Same as the word side: an explicit id list replaces the read of every grammar
        // item in the language.
        const [allItems, groupDocs] = await Promise.all([
          grammar?.grammarIds
            ? getGrammarItemsByIds(grammar.grammarIds)
            : getAllGrammarItems(language),
          scopedGroupIds
            ? Promise.all(scopedGroupIds.map((id) => getGrammarGroup(id)))
            : Promise.resolve(null),
        ]);
        let pool = allItems;
        if (groupDocs) {
          const union = new Set<string>();
          for (const g of groupDocs) {
            if (g) for (const id of g.grammarIds) union.add(id);
          }
          pool = pool.filter((it) => union.has(it.id));
        }
        let freshPool = pool;
        if (useCorrect) {
          knownGrammarItems = pool.filter((it) => isMastered(grammarProgress![it.id]));
          freshPool = pool.filter((it) => !isMastered(grammarProgress![it.id]));
        }
        if (grammarWeight > 0) {
          let ordered: Grammar[];
          if (scopedGroupIds && groupDocs) {
            const membership = assignMembership(
              scopedGroupIds,
              groupDocs.map((g) => (g ? { id: g.id, memberIds: g.grammarIds } : null)),
              freshPool
            );
            ordered = weightedInterleave(
              scopedGroupIds.map((id) => ({
                weight: grammar?.groupWeights?.[id] ?? 1,
                items: membership[id] ?? [],
              }))
            );
            grammarGroupMembership = Object.fromEntries(
              Object.entries(membership).map(([id, gs]) => [id, gs.map((g) => g.id)])
            );
          } else {
            ordered = shuffle(freshPool);
          }
          // The question is the grammar element itself; descriptions/examples are
          // fetched by the client on answer reveal.
          grammarQuestions = ordered.map(toGrammarQuestion);
        }
      }

      // Mastered items from BOTH domains form one top-level bucket, peer to word/grammar.
      const knownQuestions: CombinedQuizQuestion[] = useCorrect
        ? shuffle([...knownWordItems.map(toWordQuestion), ...knownGrammarItems.map(toGrammarQuestion)])
        : [];

      const buckets: { weight: number; items: CombinedQuizQuestion[] }[] = [
        { weight: wordWeight, items: wordQuestions },
        { weight: grammarWeight, items: grammarQuestions },
      ];
      if (useCorrect) buckets.push({ weight: correctWeight ?? 0, items: knownQuestions });
      // `weightedMerge` draws a BUCKET per pick, not an item, so even at 1:1 the smaller
      // domain drains first and clumps at the front — with 200 words against 20 grammar
      // items every grammar card lands in the first ~40 positions. One shuffle of the union
      // is the only thing that actually means "random". A zero weight still drops its
      // bucket outright: that is how "skip this domain" is expressed, and randomness is
      // about ORDER, not membership.
      const questions: CombinedQuizQuestion[] = randomOrder
        ? shuffle(buckets.filter((b) => b.weight > 0).flatMap((b) => b.items))
        : weightedMerge<CombinedQuizQuestion>(buckets);

      if (questions.length === 0) {
        return reply.badRequest("No words or grammar items match the given filters");
      }

      const session: CombinedQuizSession = {
        sessionId: opts.sessionKey(language),
        language,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        score: { correct: 0, total: questions.length },
        questions,
        domainWeights: { word: wordWeight, grammar: grammarWeight },
        initialTotal: questions.length,
        ...(word?.groupWeights ? { wordGroupWeights: word.groupWeights } : {}),
        ...(wordGroupMembership ? { wordGroupMembership } : {}),
        ...(grammar?.groupWeights ? { grammarGroupWeights: grammar.groupWeights } : {}),
        ...(grammarGroupMembership ? { grammarGroupMembership } : {}),
        ...(mixWeights ? { mixWeights } : {}),
        ...(useCorrect
          ? {
              correctWeight,
              correctMembership: {
                wordIds: knownWordItems.map((w) => w.id),
                grammarIds: knownGrammarItems.map((g) => g.id),
              },
            }
          : {}),
        ...(word?.flaggedOnly ? { flaggedOnly: true } : {}),
        ...(randomOrder ? { randomOrder: true } : {}),
      };

      await saveCombinedQuizSession(session);
      // Lightweight response: word questions carry only {kind, wordId, term}; the client
      // hydrates definitions/examples by id via POST /api/quiz/hydrate/:language. Grammar
      // questions are small (grammarId + statement) and returned as-is.
      return reply.status(201).send({
        ...session,
        questions: session.questions.map((q) =>
          q.kind === "word" ? { kind: "word", wordId: q.wordId, term: q.term } : q
        ),
      });
    }
  );

  // No hydration endpoint here on purpose: word questions carry the same payload the word
  // quiz serves, so both variants hydrate through the shared `POST /api/quiz/hydrate/:language`,
  // and grammar questions hydrate through `POST /api/grammar/:language/items/batch`.

  // Submit answer for either kind; wrong answers are re-queued into the tail.
  fastify.post<{
    Body: {
      language: string;
      kind: "word" | "grammar";
      refId: string;
      correct: boolean;
      flagWordIds?: string[];
    };
  }>(
    "/answer",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "kind", "refId", "correct"],
          properties: {
            language: { type: "string" },
            kind: { type: "string", enum: ["word", "grammar"] },
            refId: { type: "string" },
            correct: { type: "boolean" },
            flagWordIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, kind, refId, correct, flagWordIds } = request.body;
      const session = await getCombinedQuizSession(opts.sessionKey(language));
      if (!session) return reply.notFound("No combined quiz session found for this language");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const question = session.questions.find(
        (q) =>
          q.userCorrect === undefined &&
          (kind === "word"
            ? q.kind === "word" && q.wordId === refId
            : q.kind === "grammar" && q.grammarId === refId)
      );
      if (!question) return reply.notFound(`Question '${kind}:${refId}' not in this session`);

      question.userCorrect = correct;
      if (correct) {
        session.score.correct++;
      } else {
        const retry: CombinedQuizQuestion =
          question.kind === "word"
            ? {
                kind: "word",
                wordId: question.wordId,
                term: question.term,
                definitions: question.definitions ?? [],
                transliteration: question.transliteration,
                examples: question.examples,
              }
            : {
                kind: "grammar",
                grammarId: question.grammarId,
                statement: question.statement,
              };
        insertRetryQuestion(session.questions, retry, session.questions.indexOf(question));
        session.score.total++;
        // A wrong answer means it's no longer "already-correct": drop it from the mastered
        // bucket so its retry is treated as a normal (unmastered) item for the rest of the session.
        if (session.correctMembership) {
          if (kind === "word") {
            session.correctMembership.wordIds = session.correctMembership.wordIds.filter((id) => id !== refId);
          } else {
            session.correctMembership.grammarIds = session.correctMembership.grammarIds.filter((id) => id !== refId);
          }
        }
      }

      // Update per-domain progress (same bookkeeping as the standalone quizzes).
      if (kind === "word") {
        const wp: WordProgress = { ...(await getWordProgress(language, refId)) };
        wp.timesSeen++;
        if (correct) {
          wp.timesCorrect++;
          wp.streak++;
        } else {
          wp.streak = 0;
        }
        wp.correctRate = wp.timesCorrect / wp.timesSeen;
        wp.lastReviewed = new Date().toISOString();
        await updateWordProgress(language, refId, wp);
      } else {
        const gp = await getGrammarComponentProgress(language, refId);
        gp.timesSeen++;
        if (correct) {
          gp.timesCorrect++;
          gp.streak++;
        } else {
          gp.streak = 0;
        }
        gp.correctRate = gp.timesCorrect / gp.timesSeen;
        gp.lastReviewed = new Date().toISOString();
        await updateGrammarComponentProgress(language, refId, gp);
      }

      if (flagWordIds && flagWordIds.length > 0) {
        await Promise.all(flagWordIds.map((id) => flagWord(language, id).catch(() => {})));
      }

      const allAnswered = session.questions.every((q) => q.userCorrect !== undefined);
      if (allAnswered) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();
      }

      await saveCombinedQuizSession(session);
      return { session };
    }
  );

  // Get current session for a language — reorders the unanswered tail so a resumed
  // session keeps both the per-group and word/grammar weighting.
  fastify.get<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const session = await getCombinedQuizSession(opts.sessionKey(request.params.language));
      if (!session) return reply.notFound("No combined quiz session found for this language");

      reorderUnansweredTail(session);
      await saveCombinedQuizSession(session);

      return session;
    }
  );

  // Adjust domain and/or per-group weights mid-session: store the new weights and
  // reorder the unanswered tail with them. Returns the full session so the client
  // can re-sync its local order.
  fastify.put<{
    Params: { language: string };
    Body: {
      domainWeights?: { word?: number; grammar?: number };
      wordGroupWeights?: Record<string, number>;
      grammarGroupWeights?: Record<string, number>;
      mixWeights?: MixWeightConfig;
      correctWeight?: number;
    };
  }>(
    "/session/language/:language/weights",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            domainWeights: {
              type: "object",
              properties: {
                word: { type: "number", minimum: 0 },
                grammar: { type: "number", minimum: 0 },
              },
            },
            wordGroupWeights: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
            grammarGroupWeights: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
            mixWeights: MIX_WEIGHTS_SCHEMA,
            correctWeight: { type: "number", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await getCombinedQuizSession(opts.sessionKey(request.params.language));
      if (!session) return reply.notFound("No combined quiz session found for this language");
      if (session.status === "completed") return reply.badRequest("Session already completed");
      // The client hides the weights panel for these sessions; refuse anyway, or the stored
      // weights would disagree with the order `reorderUnansweredTail` actually produces.
      if (session.randomOrder) return reply.badRequest("This session is unweighted (random order)");

      const { domainWeights, wordGroupWeights, grammarGroupWeights, mixWeights, correctWeight } =
        request.body;
      if (correctWeight !== undefined) {
        session.correctWeight = correctWeight;
        // Activate the mastered partition on demand if the session didn't start with one.
        if (!session.correctMembership) {
          const [wp, gp] = await Promise.all([
            getProgressForLanguage(request.params.language),
            getGrammarProgressForLanguage(request.params.language),
          ]);
          const wordIds: string[] = [];
          const grammarIds: string[] = [];
          for (const q of session.questions) {
            if (q.userCorrect !== undefined) continue;
            if (q.kind === "word") {
              if (isMastered(wp.words[q.wordId])) wordIds.push(q.wordId);
            } else if (isMastered(gp[q.grammarId])) {
              grammarIds.push(q.grammarId);
            }
          }
          session.correctMembership = { wordIds, grammarIds };
        }
      }
      if (domainWeights) {
        const wordWeight = Math.max(0, domainWeights.word ?? session.domainWeights?.word ?? 1);
        const grammarWeight = Math.max(0, domainWeights.grammar ?? session.domainWeights?.grammar ?? 1);
        if (wordWeight <= 0 && grammarWeight <= 0 && (session.correctWeight ?? 0) <= 0) {
          return reply.badRequest("At least one of the word/grammar/already-correct weights must be positive");
        }
        session.domainWeights = { word: wordWeight, grammar: grammarWeight };
      }
      if (wordGroupWeights) {
        session.wordGroupWeights = { ...session.wordGroupWeights, ...wordGroupWeights };
      }
      if (grammarGroupWeights) {
        session.grammarGroupWeights = { ...session.grammarGroupWeights, ...grammarGroupWeights };
      }
      // Replaced wholesale, unlike the group maps above: this is one coherent set of ratios the
      // folded weights were derived from, not a per-group patch. Merging halves of two different
      // forms would describe a mix that was never requested.
      if (mixWeights) {
        session.mixWeights = mixWeights;
      }

      reorderUnansweredTail(session);
      await saveCombinedQuizSession(session);

      return session;
    }
  );
  };
}

const combinedQuizRoutes = makeCombinedQuizRoutes({ sessionKey: (l) => l });
/** Group B quiz — same handlers, session stored under `${language}__groupB`
 *  ("__" cannot occur in a language name, so the keys never collide). */
export const groupBQuizRoutes = makeCombinedQuizRoutes({ sessionKey: (l) => `${l}__groupB` });
/** Mixed A+B quiz — one session spanning both meta-groups. Nothing here knows about
 *  categories: the client simply sends category-A and category-B `groupIds` in one array
 *  (B first, so `assignMembership`'s first-wins rule gives a shared word B's weight). */
export const mixedQuizRoutes = makeCombinedQuizRoutes({ sessionKey: (l) => `${l}__mixed` });
/**
 * Article quizzes — the vocabulary and grammar of every saved import session, drilled as
 * one pool. Two registrations rather than one shared `__import` key so a Group A and a
 * Group B article drill can be in progress at once, and so "resume" is never ambiguous
 * about which of the two it means. The pool arrives as explicit `wordIds`/`grammarIds`
 * (the client owns the article↔group intersection), and `randomOrder` is what makes the
 * two domains one shuffled pile instead of a weighted interleave.
 */
export const importQuizARoutes = makeCombinedQuizRoutes({ sessionKey: (l) => `${l}__importA` });
export const importQuizBRoutes = makeCombinedQuizRoutes({ sessionKey: (l) => `${l}__importB` });

// Reorder the unanswered tail by the session's current domain + group weights,
// keeping answered questions in place. Shared by resume (GET session) and the
// mid-session weight update (PUT weights).
function reorderUnansweredTail(session: CombinedQuizSession): void {
  const answered: CombinedQuizQuestion[] = [];
  const unanswered: CombinedQuizQuestion[] = [];
  for (const q of session.questions) {
    if (q.userCorrect !== undefined) answered.push(q);
    else unanswered.push(q);
  }

  // A random-order session has no buckets to re-weight — resume must not quietly
  // reintroduce the domain interleave the session was built to avoid.
  if (session.randomOrder) {
    session.questions = [...answered, ...shuffle(unanswered)];
    return;
  }

  const useCorrect = session.correctWeight !== undefined;
  const knownWordIds = new Set(session.correctMembership?.wordIds ?? []);
  const knownGrammarIds = new Set(session.correctMembership?.grammarIds ?? []);
  const isKnown = (q: CombinedQuizQuestion): boolean =>
    q.kind === "word" ? knownWordIds.has(q.wordId) : knownGrammarIds.has(q.grammarId);
  const freshUnanswered = useCorrect ? unanswered.filter((q) => !isKnown(q)) : unanswered;

  const wordTail = reweightDomain(
    freshUnanswered.filter((q): q is CombinedQuizWordQuestion => q.kind === "word"),
    session.wordGroupMembership,
    session.wordGroupWeights,
    (q) => q.wordId
  );
  const grammarTail = reweightDomain(
    freshUnanswered.filter((q): q is CombinedQuizGrammarQuestion => q.kind === "grammar"),
    session.grammarGroupMembership,
    session.grammarGroupWeights,
    (q) => q.grammarId
  );
  const merged = weightedMerge<CombinedQuizQuestion>([
    { weight: session.domainWeights?.word ?? 1, items: wordTail },
    { weight: session.domainWeights?.grammar ?? 1, items: grammarTail },
    ...(useCorrect
      ? [{ weight: session.correctWeight ?? 0, items: shuffle(unanswered.filter(isKnown)) }]
      : []),
  ]);
  // weightedMerge drops zero-weight buckets; never lose questions.
  const covered = new Set(merged);
  for (const q of unanswered) {
    if (!covered.has(q)) merged.push(q);
  }
  session.questions = [...answered, ...merged];
}

// Assign each pooled word to exactly one selected group (first group in groupIds order that
// contains it) — mirrors buildGroupMembership in routes/quiz.ts.
async function buildWordMembership(
  groupIds: string[],
  pool: Word[]
): Promise<Record<string, Word[]>> {
  const groupDocs = await Promise.all(groupIds.map((id) => getWordGroup(id)));
  return assignMembership(
    groupIds,
    groupDocs.map((g) => (g ? { id: g.id, memberIds: g.wordIds } : null)),
    pool
  );
}

// (The grammar side has no `buildGrammarMembership` twin: /start already holds the group docs
// it fetched to scope the pool, and calls `assignMembership` with them directly.)

function assignMembership<T extends { id: string }>(
  groupIds: string[],
  groupDocs: ({ id: string; memberIds: string[] } | null)[],
  pool: T[]
): Record<string, T[]> {
  const itemById = new Map(pool.map((item) => [item.id, item]));
  const assigned = new Set<string>();
  const membership: Record<string, T[]> = {};
  for (const id of groupIds) membership[id] = [];
  for (const g of groupDocs) {
    if (!g) continue;
    for (const memberId of g.memberIds) {
      if (itemById.has(memberId) && !assigned.has(memberId)) {
        assigned.add(memberId);
        membership[g.id].push(itemById.get(memberId)!);
      }
    }
  }
  return membership;
}

// Re-order one domain's unanswered tail on resume using its stored membership/weights;
// falls back to a uniform shuffle for ungrouped domains (mirrors reweightUnanswered).
function reweightDomain<T extends object>(
  unanswered: T[],
  membership: Record<string, string[]> | undefined,
  weights: Record<string, number> | undefined,
  idOf: (q: T) => string
): T[] {
  if (!membership || Object.keys(membership).length === 0) {
    return shuffle(unanswered);
  }
  const byId = new Map<string, T>();
  for (const q of unanswered) byId.set(idOf(q), q);
  const buckets = Object.entries(membership).map(([gid, ids]) => ({
    weight: weights?.[gid] ?? 1,
    items: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
  }));
  const ordered = weightedInterleave(buckets);
  // Append any unanswered question not covered by the stored membership (includes retry
  // duplicates collapsed by the byId map).
  const covered = new Set(ordered);
  for (const q of unanswered) {
    if (!covered.has(q)) ordered.push(q);
  }
  return ordered;
}

export default combinedQuizRoutes;
