import type { FastifyPluginAsync } from "fastify";
import {
  getAllGrammarItems,
  getGrammarItem,
  getGrammarGroup,
  getGrammarProgressForLanguage,
  getGrammarComponentProgress,
  updateGrammarComponentProgress,
  getGrammarQuizSession,
  saveGrammarQuizSession,
  lookupWordsByTerms,
  addWord,
  getNextWordId,
  getNextExampleId,
  flagWord,
  addExampleSentence,
  findExampleByText,
  linkWordToExistingExamples,
} from "../firestore.js";
import type {
  Grammar,
  GrammarGroup,
  GrammarQuizSession,
  GrammarQuizQuestion,
  Word,
  Meaning,
  ExampleSentence,
} from "../types.js";
import { TOPICS } from "../types.js";
import { callLLM, stripMarkdownFences } from "../llm.js";
import { shuffle, weightedInterleave, isMastered } from "../quiz-utils.js";

const grammarQuizRoutes: FastifyPluginAsync = async (fastify) => {
  // Start grammar quiz
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      groupIds?: string[];
      groupWeights?: Record<string, number>;
      correctWeight?: number;
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
            questionCount: { type: "number", minimum: 1 },
            groupIds: { type: "array", items: { type: "string" } },
            groupWeights: { type: "object", additionalProperties: { type: "number" } },
            correctWeight: { type: "number", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, groupIds, groupWeights, correctWeight } = request.body;

      let pool = await getAllGrammarItems(language);

      let groupDocs: (GrammarGroup | null)[] = [];
      if (groupIds && groupIds.length > 0) {
        groupDocs = await Promise.all(groupIds.map((id) => getGrammarGroup(id)));
        const union = new Set<string>();
        for (const g of groupDocs) {
          if (g) for (const gid of g.grammarIds) union.add(gid);
        }
        pool = pool.filter((item) => union.has(item.id));
      }

      if (pool.length === 0) {
        return reply.badRequest("No grammar items match the given filters");
      }

      // Default to the ENTIRE matching pool (mirrors the word quiz): every item of the
      // selected groups is asked, and weights only decide the ORDER, not who makes the cut.
      const count = questionCount ? Math.min(questionCount, pool.length) : pool.length;

      // Optionally split already-mastered items into their own weighted bucket, peer to the
      // groups (correctWeight 0 = exclude them; >0 = mix them back in). Only active when
      // correctWeight is provided — otherwise behavior is unchanged.
      let freshPool = pool;
      let knownItems: Grammar[] = [];
      let correctMembership: string[] | undefined;
      if (correctWeight !== undefined) {
        const progressMap = await getGrammarProgressForLanguage(language);
        knownItems = pool.filter((it) => isMastered(progressMap[it.id]));
        freshPool = pool.filter((it) => !isMastered(progressMap[it.id]));
        correctMembership = knownItems.map((it) => it.id);
      }

      // When groups are selected, order the pool by a weighted interleave (mirrors the
      // word quiz): each next item's group is drawn proportionally to its weight (default
      // 1), then a random item from it. Otherwise items are picked completely at random
      // (uniform shuffle) — weight only comes in via the already-mastered bucket when
      // correctWeight is set.
      let selected: Grammar[];
      let groupMembership: Record<string, string[]> | undefined;
      if (groupIds && groupIds.length > 0) {
        const membership = buildGrammarGroupMembership(groupIds, groupDocs, freshPool);
        const buckets = groupIds.map((id) => ({
          weight: groupWeights?.[id] ?? 1,
          items: membership[id] ?? [],
        }));
        if (correctWeight !== undefined) buckets.push({ weight: correctWeight, items: knownItems });
        selected = weightedInterleave(buckets).slice(0, count);
        groupMembership = Object.fromEntries(
          Object.entries(membership).map(([id, items]) => [id, items.map((i) => i.id)])
        );
      } else if (correctWeight !== undefined) {
        // Ungrouped + already-correct: fresh vs mastered as two peer buckets.
        selected = weightedInterleave([
          { weight: 1, items: freshPool },
          { weight: correctWeight, items: knownItems },
        ]).slice(0, count);
      } else {
        selected = randomSample(pool, count);
      }

      if (selected.length === 0) {
        return reply.badRequest(
          "No grammar items match the given filters (all matching items are already mastered — raise the 'already correct' weight to review them)"
        );
      }

      // The question is the grammar element itself; descriptions/examples are
      // fetched by the client on answer reveal.
      const questions: GrammarQuizQuestion[] = selected.map((item) => ({
        grammarId: item.id,
        statement: item.statement,
      }));

      const session: GrammarQuizSession = {
        sessionId: language,
        language,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        reviewedQuestionCount: 0,
        score: { correct: 0, total: questions.length },
        questions,
        ...(groupIds && groupIds.length > 0 ? { groupFilter: groupIds } : {}),
        ...(groupWeights ? { groupWeights } : {}),
        ...(groupMembership ? { groupMembership } : {}),
        ...(correctWeight !== undefined ? { correctWeight } : {}),
        ...(correctMembership ? { correctMembership } : {}),
      };

      await saveGrammarQuizSession(session);
      return reply.status(201).send(session);
    }
  );

  // Submit answer (self-graded)
  fastify.post<{
    Body: { language: string; grammarId: string; correct: boolean };
  }>(
    "/answer",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "grammarId", "correct"],
          properties: {
            language: { type: "string" },
            grammarId: { type: "string" },
            correct: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, grammarId, correct } = request.body;

      const session = await getGrammarQuizSession(language);
      if (!session) return reply.notFound("No grammar quiz session found");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const question = session.questions.find(
        (q) => q.grammarId === grammarId && q.userCorrect === undefined
      );
      if (!question) return reply.notFound("Question not found in session");

      question.userCorrect = correct;
      if (correct) {
        session.score.correct++;
      } else {
        // Re-queue wrong answer
        const item = await getGrammarItem(grammarId);
        if (item) {
          session.questions.push({
            grammarId,
            statement: question.statement ?? item.statement,
          });
          session.score.total++;
        }
        // A wrong answer means it's no longer "already-correct": drop it from the mastered
        // bucket so its retry is treated as a normal (unmastered) item for the rest of the session.
        if (session.correctMembership) {
          session.correctMembership = session.correctMembership.filter((id) => id !== grammarId);
        }
      }

      // Update grammar progress
      const gp = await getGrammarComponentProgress(language, grammarId);
      gp.timesSeen++;
      if (correct) {
        gp.timesCorrect++;
        gp.streak++;
      } else {
        gp.streak = 0;
      }
      gp.correctRate = gp.timesCorrect / gp.timesSeen;
      gp.lastReviewed = new Date().toISOString();
      await updateGrammarComponentProgress(language, grammarId, gp);

      // Check if session is complete
      const allAnswered = session.questions.every((q) => q.userCorrect !== undefined);
      if (allAnswered) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();
      }

      await saveGrammarQuizSession(session);
      return { session, grammarProgress: gp };
    }
  );

  // Get current grammar quiz session. Like the word and combined quizzes, resuming REGENERATES
  // the remaining questions: the unanswered tail is re-drawn with the stored group weights, so
  // a refresh or a resume-from-home gives a freshly ordered quiz rather than the stale tail.
  fastify.get<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const session = await getGrammarQuizSession(request.params.language);
      if (!session) return reply.notFound("No grammar quiz session found");

      const answered: GrammarQuizQuestion[] = [];
      const unanswered: GrammarQuizQuestion[] = [];
      for (const q of session.questions) {
        if (q.userCorrect !== undefined) answered.push(q);
        else unanswered.push(q);
      }
      session.questions = [...answered, ...reweightUnansweredGrammar(unanswered, session)];
      await saveGrammarQuizSession(session);

      return session;
    }
  );

  fastify.put<{ Params: { language: string }; Body: { startedAt: string } }>(
    "/session/language/:language/reviewed",
    async (request, reply) => {
      const session = await getGrammarQuizSession(request.params.language);
      if (!session) return reply.notFound("No grammar quiz session found");
      if (session.startedAt !== request.body.startedAt) {
        return reply.conflict("The quiz session has been replaced");
      }
      session.reviewedQuestionCount = session.questions.filter(
        (q) => q.userCorrect !== undefined
      ).length;
      await saveGrammarQuizSession(session);
      return { reviewedQuestionCount: session.reviewedQuestionCount };
    }
  );

  // Adjust per-group weights mid-session: store the new weights and reorder the
  // unanswered tail with them. Returns the full session so the client can re-sync
  // its local order.
  fastify.put<{
    Params: { language: string };
    Body: { groupWeights: Record<string, number>; correctWeight?: number };
  }>(
    "/session/language/:language/weights",
    {
      schema: {
        body: {
          type: "object",
          required: ["groupWeights"],
          properties: {
            groupWeights: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
            correctWeight: { type: "number", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await getGrammarQuizSession(request.params.language);
      if (!session) return reply.notFound("No grammar quiz session found");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      session.groupWeights = { ...session.groupWeights, ...request.body.groupWeights };
      if (request.body.correctWeight !== undefined) {
        session.correctWeight = request.body.correctWeight;
        if (!session.correctMembership) {
          const progressMap = await getGrammarProgressForLanguage(request.params.language);
          session.correctMembership = session.questions
            .filter((q) => q.userCorrect === undefined && isMastered(progressMap[q.grammarId]))
            .map((q) => q.grammarId);
        }
      }
      const answered: GrammarQuizQuestion[] = [];
      const unanswered: GrammarQuizQuestion[] = [];
      for (const q of session.questions) {
        if (q.userCorrect !== undefined) answered.push(q);
        else unanswered.push(q);
      }
      session.questions = [...answered, ...reweightUnansweredGrammar(unanswered, session)];
      await saveGrammarQuizSession(session);

      return session;
    }
  );

  // Check which terms are missing from the word DB
  fastify.post<{
    Body: { language: string; terms: string[] };
  }>(
    "/check-missing-words",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "terms"],
          properties: {
            language: { type: "string" },
            terms: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request) => {
      const { language, terms } = request.body;
      if (terms.length === 0) return { missing: [] };
      const existing = await lookupWordsByTerms(language, terms);
      const existingSet = new Set(existing.map((e) => e.term));
      const missing = terms.filter((t) => !existingSet.has(t));
      return { missing };
    }
  );

  // Batch-add missing words from grammar quiz segments
  fastify.post<{
    Body: {
      language: string;
      words: { term: string; pinyin: string; sentence: string; translation: string }[];
    };
  }>(
    "/add-missing-words",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "words"],
          properties: {
            language: { type: "string" },
            words: {
              type: "array",
              items: {
                type: "object",
                required: ["term", "pinyin", "sentence", "translation"],
                properties: {
                  term: { type: "string" },
                  pinyin: { type: "string" },
                  sentence: { type: "string" },
                  translation: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { language, words } = request.body;
      if (words.length === 0) return { added: [] };

      const systemPrompt = `You are a Chinese vocabulary expert. Generate vocabulary entries for Chinese words.
Each word already has a term, transliteration (pinyin), and one example sentence provided.
You need to fill: definitions, topics, notes.

Return a JSON object with a "words" array:
[{
  "term": "the word (keep as provided)",
  "transliteration": "keep as provided",
  "definitions": [{ "partOfSpeech": "noun|verb|adjective|adverb|preposition|conjunction|particle|measure word|pronoun|interjection|idiom|set phrase|phrasal verb|collocation|proverb|greeting", "text": { "ja": "...", "en": "...", "ko": "..." } }],
  "topics": ["..."],
  "notes": "brief usage notes or empty string"
}]

Allowed topics: ${TOPICS.join(", ")}`;

      const userPrompt = words
        .map((w) => `- ${w.term} (${w.pinyin}), example: "${w.sentence}" → "${w.translation}"`)
        .join("\n");

      const raw = await callLLM({ system: systemPrompt, user: `Generate entries for these words:\n\n${userPrompt}`, route: "grammar-quiz/batch-add" });
      const parsed = JSON.parse(stripMarkdownFences(raw));
      const generated: unknown[] = parsed.words ?? [];

      const added: Word[] = [];
      const addedTerms = new Set<string>();

      for (const g of generated) {
        if (!g || typeof g !== "object") continue;
        const entry = g as Record<string, unknown>;
        const term = entry.term as string;
        if (!term || addedTerms.has(term)) continue;

        const info = words.find((w) => w.term === term);
        if (!info) continue;

        const id = await getNextWordId(language);
        const topics = ((entry.topics as string[]) ?? []).filter((t) => (TOPICS as readonly string[]).includes(t));

        // Create example sentence document
        const exampleIds: string[] = [];
        const existingEx = await findExampleByText(language, info.sentence);
        if (existingEx) {
          exampleIds.push(existingEx.id);
        } else {
          const exId = await getNextExampleId(language);
          const es: ExampleSentence = {
            id: exId,
            sentence: info.sentence,
            translation: info.translation,
            language,
          };
          await addExampleSentence(es);
          exampleIds.push(exId);
        }

        const newWord: Word = {
          id,
          term,
          transliteration: (entry.transliteration as string) || info.pinyin || "",
          definitions: (entry.definitions as Meaning[]) || [{ partOfSpeech: "", text: { en: "" } }],
          examples: [{ sentence: info.sentence, translation: info.translation }],
          topics: (topics.length > 0 ? topics : ["Language Fundamentals"]) as Word["topics"],
          level: "Advanced",
          notes: (entry.notes as string) || "",
        };

        // addWord now defaults appearsInIds to include own exampleIds.
        await addWord(language, newWord, { exampleIds });
        // Reverse-link: find existing examples where this word's term is a segment
        await linkWordToExistingExamples(language, id, term);
        await flagWord(language, newWord.id);
        addedTerms.add(term);
        added.push(newWord);
      }

      return { added };
    }
  );
};

function randomSample(items: Grammar[], count: number): Grammar[] {
  return shuffle(items).slice(0, count);
}

// Assign each pooled item to exactly one of the selected groups — the first group (in
// groupIds order) whose membership contains it — so weighted draws have well-defined
// denominators and each item appears once. Mirrors quiz.ts's buildGroupMembership.
function buildGrammarGroupMembership(
  groupIds: string[],
  groupDocs: (GrammarGroup | null)[],
  pool: Grammar[]
): Record<string, Grammar[]> {
  const itemById = new Map(pool.map((item) => [item.id, item]));
  const assigned = new Set<string>();
  const membership: Record<string, Grammar[]> = {};
  for (const id of groupIds) membership[id] = [];
  for (const g of groupDocs) {
    if (!g) continue;
    for (const gid of g.grammarIds) {
      if (itemById.has(gid) && !assigned.has(gid)) {
        assigned.add(gid);
        membership[g.id].push(itemById.get(gid)!);
      }
    }
  }
  return membership;
}

// Re-order the unanswered tail by the session's current per-group weights (mirrors the
// word quiz's reweightUnanswered). Ungrouped sessions with no already-correct bucket just
// get a uniform shuffle.
function reweightUnansweredGrammar(
  unanswered: GrammarQuizQuestion[],
  session: GrammarQuizSession
): GrammarQuizQuestion[] {
  const membership = session.groupMembership;
  const hasCorrect = session.correctWeight !== undefined;
  if ((!membership || Object.keys(membership).length === 0) && !hasCorrect) {
    return shuffle(unanswered);
  }
  const knownSet = new Set(session.correctMembership ?? []);
  const byGrammarId = new Map<string, GrammarQuizQuestion>();
  for (const q of unanswered) byGrammarId.set(q.grammarId, q);

  const buckets: { weight: number; items: GrammarQuizQuestion[] }[] = [];
  if (membership && Object.keys(membership).length > 0) {
    for (const [gid, ids] of Object.entries(membership)) {
      buckets.push({
        weight: session.groupWeights?.[gid] ?? 1,
        items: ids
          .filter((id) => byGrammarId.has(id) && !knownSet.has(id))
          .map((id) => byGrammarId.get(id)!),
      });
    }
  } else if (hasCorrect) {
    buckets.push({ weight: 1, items: unanswered.filter((q) => !knownSet.has(q.grammarId)) });
  }
  if (hasCorrect) {
    buckets.push({
      weight: session.correctWeight ?? 0,
      items: unanswered.filter((q) => knownSet.has(q.grammarId)),
    });
  }
  const ordered = weightedInterleave(buckets);
  // Append any unanswered question not covered by a bucket (e.g. a zero-weight bucket).
  const covered = new Set(ordered.map((q) => q.grammarId));
  for (const q of unanswered) {
    if (!covered.has(q.grammarId)) ordered.push(q);
  }
  return ordered;
}

export default grammarQuizRoutes;
