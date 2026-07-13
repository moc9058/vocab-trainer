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
  GrammarProgress,
  Word,
  Meaning,
  ExampleSentence,
} from "../types.js";
import { TOPICS } from "../types.js";
import { callLLM, stripMarkdownFences } from "../llm.js";
import { weightedInterleave } from "../quiz-utils.js";

const grammarQuizRoutes: FastifyPluginAsync = async (fastify) => {
  // Start grammar quiz
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      groupIds?: string[];
      groupWeights?: Record<string, number>;
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
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, groupIds, groupWeights } = request.body;

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

      const progressMap = await getGrammarProgressForLanguage(language);
      const count = questionCount ? Math.min(questionCount, pool.length) : Math.min(10, pool.length);

      // When groups are selected, order the pool by a weighted interleave (mirrors the
      // word quiz): each next item's group is drawn proportionally to its weight (default
      // 1), then a random item from it. Otherwise fall back to the existing spaced-repetition
      // sampling (unseen / overdue / low-accuracy items weighted higher).
      let selected: Grammar[];
      let groupMembership: Record<string, string[]> | undefined;
      if (groupIds && groupIds.length > 0) {
        const membership = buildGrammarGroupMembership(groupIds, groupDocs, pool);
        const buckets = groupIds.map((id) => ({
          weight: groupWeights?.[id] ?? 1,
          items: membership[id] ?? [],
        }));
        selected = weightedInterleave(buckets).slice(0, count);
        groupMembership = Object.fromEntries(
          Object.entries(membership).map(([id, items]) => [id, items.map((i) => i.id)])
        );
      } else {
        selected = weightedSample(pool, count, progressMap);
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
        score: { correct: 0, total: questions.length },
        questions,
        ...(groupIds && groupIds.length > 0 ? { groupFilter: groupIds } : {}),
        ...(groupWeights ? { groupWeights } : {}),
        ...(groupMembership ? { groupMembership } : {}),
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

  // Get current grammar quiz session
  fastify.get<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const session = await getGrammarQuizSession(request.params.language);
      if (!session) return reply.notFound("No grammar quiz session found");
      return session;
    }
  );

  // Adjust per-group weights mid-session: store the new weights and reorder the
  // unanswered tail with them. Returns the full session so the client can re-sync
  // its local order.
  fastify.put<{
    Params: { language: string };
    Body: { groupWeights: Record<string, number> };
  }>(
    "/session/language/:language/weights",
    {
      schema: {
        body: {
          type: "object",
          required: ["groupWeights"],
          properties: {
            groupWeights: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await getGrammarQuizSession(request.params.language);
      if (!session) return reply.notFound("No grammar quiz session found");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      session.groupWeights = { ...session.groupWeights, ...request.body.groupWeights };
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

      const raw = await callLLM(systemPrompt, `Generate entries for these words:\n\n${userPrompt}`, "grammar-quiz/batch-add");
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

function weightedSample(
  items: Grammar[],
  count: number,
  progressMap: Record<string, GrammarProgress>
): Grammar[] {
  const now = Date.now();
  const weighted = items.map((item) => {
    const p = progressMap[item.id];
    let weight = 1;

    if (!p || p.timesSeen === 0) {
      weight = 5;
    } else {
      weight += (1 - p.correctRate) * 4;
      const daysSince = (now - new Date(p.lastReviewed).getTime()) / (1000 * 60 * 60 * 24);
      weight += Math.min(daysSince, 7) * 0.5;
    }

    return { item, weight };
  });

  const selected: Grammar[] = [];
  const remaining = [...weighted];

  for (let i = 0; i < count && remaining.length > 0; i++) {
    const totalWeight = remaining.reduce((sum, entry) => sum + entry.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < remaining.length - 1; idx++) {
      r -= remaining[idx].weight;
      if (r <= 0) break;
    }
    selected.push(remaining[idx].item);
    remaining.splice(idx, 1);
  }

  return selected;
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

// Re-order the unanswered tail by the session's current per-group weights. Ungrouped
// sessions (no stored membership) are left in their existing order — unlike the word
// quiz, an ungrouped grammar session's order already reflects spaced-repetition weight
// (see weightedSample), so there is no uniform-shuffle fallback to apply here.
function reweightUnansweredGrammar(
  unanswered: GrammarQuizQuestion[],
  session: GrammarQuizSession
): GrammarQuizQuestion[] {
  const membership = session.groupMembership;
  if (!membership || Object.keys(membership).length === 0) {
    return unanswered;
  }
  const byGrammarId = new Map<string, GrammarQuizQuestion>();
  for (const q of unanswered) byGrammarId.set(q.grammarId, q);
  const buckets = Object.entries(membership).map(([gid, ids]) => ({
    weight: session.groupWeights?.[gid] ?? 1,
    items: ids.filter((id) => byGrammarId.has(id)).map((id) => byGrammarId.get(id)!),
  }));
  const ordered = weightedInterleave(buckets);
  // Append any unanswered question not covered by the stored membership.
  const covered = new Set(ordered.map((q) => q.grammarId));
  for (const q of unanswered) {
    if (!covered.has(q.grammarId)) ordered.push(q);
  }
  return ordered;
}

export default grammarQuizRoutes;
