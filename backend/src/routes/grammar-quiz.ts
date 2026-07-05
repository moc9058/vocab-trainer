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
  getExampleSentencesByIds,
} from "../firestore.js";
import type {
  Grammar,
  GrammarQuizSession,
  GrammarQuizQuestion,
  GrammarProgress,
  Word,
  Meaning,
  ExampleSentence,
} from "../types.js";
import { TOPICS } from "../types.js";
import { callLLM, stripMarkdownFences } from "../llm.js";

const grammarQuizRoutes: FastifyPluginAsync = async (fastify) => {
  // Start grammar quiz
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      groupIds?: string[];
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
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, groupIds } = request.body;

      let pool = await getAllGrammarItems(language);

      if (groupIds && groupIds.length > 0) {
        const groupDocs = await Promise.all(groupIds.map((id) => getGrammarGroup(id)));
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
      const selected = weightedSample(pool, count, progressMap);

      // Prepare questions
      const questions: GrammarQuizQuestion[] = [];
      for (const item of selected) {
        try {
          const prepared = await prepareQuestion(item);
          questions.push({
            grammarId: item.id,
            exampleSentence: prepared.sentence,
            exampleTranslation: prepared.translation,
            ...(prepared.transliteration ? { exampleTransliteration: prepared.transliteration } : {}),
          });
        } catch (err) {
          fastify.log.error({ err, grammarId: item.id }, "Failed to prepare grammar question");
          const fallback = item.examples?.[0];
          questions.push({
            grammarId: item.id,
            exampleSentence: fallback?.sentence ?? item.statement,
            exampleTranslation: fallback?.translation ?? "",
            ...(fallback?.transliteration ? { exampleTransliteration: fallback.transliteration } : {}),
          });
        }
      }

      const session: GrammarQuizSession = {
        sessionId: language,
        language,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        score: { correct: 0, total: questions.length },
        questions,
        ...(groupIds && groupIds.length > 0 ? { groupFilter: groupIds } : {}),
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
            exampleSentence: question.exampleSentence,
            exampleTranslation: question.exampleTranslation,
            ...(question.exampleTransliteration
              ? { exampleTransliteration: question.exampleTransliteration }
              : {}),
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

interface PreparedQuestion {
  sentence: string;
  translation: string | Record<string, string>;
  transliteration?: string;
}

// Also used by routes/combined-quiz.ts to build grammar questions.
export async function prepareQuestion(item: Grammar): Promise<PreparedQuestion> {
  // Prefer hydrating from the normalized example_sentences collection.
  if (item.exampleIds && item.exampleIds.length > 0) {
    const docs = await getExampleSentencesByIds(item.exampleIds);
    if (docs.length > 0) {
      const es = docs[Math.floor(Math.random() * docs.length)];
      return { sentence: es.sentence, translation: es.translation };
    }
  }

  // Transitional fallback for pre-migration docs that still hold inline examples.
  if (item.examples && item.examples.length > 0) {
    const ex = item.examples[Math.floor(Math.random() * item.examples.length)];
    return {
      sentence: ex.sentence,
      translation: ex.translation,
      ...(ex.transliteration ? { transliteration: ex.transliteration } : {}),
    };
  }

  // No examples — synthesize one with the LLM, mirroring the user's first description text language.
  const descriptionDump = (item.descriptions ?? [])
    .map((d) => {
      const texts = Object.entries(d.text ?? {})
        .map(([lang, t]) => `${lang}: ${t}`)
        .join(" | ");
      return d.partOfSpeech ? `[${d.partOfSpeech}] ${texts}` : texts;
    })
    .filter(Boolean)
    .join("\n");

  const parts: string[] = [
    `Grammar statement: ${item.statement}`,
  ];
  if (descriptionDump) parts.push(`Descriptions:\n${descriptionDump}`);
  if (item.words && item.words.length > 0) {
    parts.push(`Related words/terms: ${item.words.join(", ")}`);
  }
  parts.push(
    ``,
    `Generate a NEW example sentence demonstrating this grammar point, and provide its translation.`,
    `Return JSON: { "sentence": "...", "translation": "..." }`,
  );

  const raw = await callLLM(
    "You are a grammar example generator. Return valid JSON only.",
    parts.join("\n"),
    "grammar-quiz/generate-sentence"
  );

  const parsed = JSON.parse(stripMarkdownFences(raw));
  return {
    sentence: parsed.sentence ?? item.statement,
    translation: parsed.translation ?? "",
  };
}

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

export default grammarQuizRoutes;
