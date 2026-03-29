import type { FastifyPluginAsync } from "fastify";
import {
  getAllGrammarItems,
  getGrammarItem,
  getGrammarProgressForLanguage,
  getGrammarComponentProgress,
  updateGrammarComponentProgress,
  getGrammarQuizSession,
  saveGrammarQuizSession,
  lookupWordsByTerms,
  addWord,
  getNextWordId,
  flagWord,
  type GrammarItemDoc,
} from "../firestore.js";
import type { GrammarQuizSession, GrammarQuizQuestion, GrammarProgress, Word, Meaning } from "../types.js";
import { TOPICS } from "../types.js";
import { callLLM, stripMarkdownFences, segmentBatch } from "../llm.js";

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  ko: "Korean",
};

const grammarQuizRoutes: FastifyPluginAsync = async (fastify) => {
  // Start grammar quiz
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      chapters?: number[];
      subchapters?: string[];
      displayLanguage?: string;
      quizMode?: string;
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
            chapters: { type: "array", items: { type: "number" } },
            subchapters: { type: "array", items: { type: "string" } },
            displayLanguage: { type: "string" },
            quizMode: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, chapters, subchapters, displayLanguage, quizMode } = request.body;
      const dispLang = displayLanguage || "ja";
      const mode = language === "chinese" ? "llm" : (quizMode || "existing");

      let pool = await getAllGrammarItems(language);

      if (chapters && chapters.length > 0) {
        pool = pool.filter((item) => chapters.includes(item.chapterNumber));
      }
      if (subchapters && subchapters.length > 0) {
        pool = pool.filter((item) => subchapters.includes(item.subchapterId));
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
          const prepared = await prepareQuestion(item, dispLang, mode);
          questions.push({
            componentId: item.id,
            displaySentence: prepared.displaySentence,
            chineseSentence: prepared.chineseSentence,
            segments: prepared.segments,
          });
        } catch (err) {
          fastify.log.error({ err, componentId: item.id }, "Failed to prepare grammar question");
          questions.push({
            componentId: item.id,
            displaySentence: Object.values(item.term).join(" / "),
            chineseSentence: item.examples?.[0]?.sentence ?? "",
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
        ...(chapters ? { chapterFilter: chapters } : {}),
        ...(subchapters ? { subchapterFilter: subchapters } : {}),
        displayLanguage: dispLang,
        quizMode: mode,
      };

      await saveGrammarQuizSession(session);
      return reply.status(201).send(session);
    }
  );

  // Submit answer (self-graded)
  fastify.post<{
    Body: { language: string; componentId: string; correct: boolean };
  }>(
    "/answer",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "componentId", "correct"],
          properties: {
            language: { type: "string" },
            componentId: { type: "string" },
            correct: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, componentId, correct } = request.body;

      const session = await getGrammarQuizSession(language);
      if (!session) return reply.notFound("No grammar quiz session found");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const question = session.questions.find(
        (q) => q.componentId === componentId && q.userCorrect === undefined
      );
      if (!question) return reply.notFound("Question not found in session");

      question.userCorrect = correct;
      if (correct) {
        session.score.correct++;
      } else {
        // Re-queue wrong answer
        const item = await getGrammarItem(componentId);
        if (item) {
          session.questions.push({
            componentId,
            displaySentence: question.displaySentence,
            chineseSentence: question.chineseSentence,
            segments: question.segments,
          });
          session.score.total++;
        }
      }

      // Update grammar progress
      const gp = await getGrammarComponentProgress(language, componentId);
      gp.timesSeen++;
      if (correct) {
        gp.timesCorrect++;
        gp.streak++;
      } else {
        gp.streak = 0;
      }
      gp.correctRate = gp.timesCorrect / gp.timesSeen;
      gp.lastReviewed = new Date().toISOString();
      await updateGrammarComponentProgress(language, componentId, gp);

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

        await addWord(language, newWord);
        await flagWord(language, newWord.id);
        addedTerms.add(term);
        added.push(newWord);
      }

      return { added };
    }
  );
};

interface PreparedQuestion {
  displaySentence: string;
  chineseSentence: string;
  segments?: { text: string; pinyin?: string }[];
}

async function prepareQuestion(
  item: GrammarItemDoc,
  displayLanguage: string,
  mode: string
): Promise<PreparedQuestion> {
  const langName = LANG_NAMES[displayLanguage] || "Japanese";

  if (mode === "existing" && item.examples && item.examples.length > 0) {
    // Pick a random example
    const ex = item.examples[Math.floor(Math.random() * item.examples.length)];
    const chineseSentence = ex.sentence;

    let displaySentence: string;
    // Check if translation exists in display language
    if (ex.translation) {
      if (displayLanguage === "en") {
        displaySentence = ex.translation;
      } else {
        const raw = await callLLM(
          "You are a translator. Return valid JSON only.",
          `Translate the following sentence to ${langName}. Return JSON: { "translation": "..." }

Sentence: ${ex.translation}`,
          "grammar-quiz/translate"
        );
        const parsed = JSON.parse(stripMarkdownFences(raw));
        displaySentence = parsed.translation ?? ex.translation;
      }
    } else {
      const generated = await generateSentencePair(item, langName);
      return generated;
    }

    // Segment the Chinese sentence for pinyin display
    const segMap = await segmentBatch([chineseSentence]);
    const segments = segMap.get(0)?.map((s) => ({ text: s.text, pinyin: s.transliteration }));
    return { displaySentence, chineseSentence, segments };
  }

  // LLM mode or no examples available — generate fresh
  return await generateSentencePair(item, langName);
}

async function generateSentencePair(
  item: GrammarItemDoc,
  langName: string
): Promise<PreparedQuestion> {
  const parts: string[] = [
    `Given this Chinese grammar point:`,
    `Term: ${JSON.stringify(item.term)}`,
  ];
  if (item.description && Object.keys(item.description).length > 0) {
    parts.push(`Description: ${JSON.stringify(item.description)}`);
  }
  if (item.words && item.words.length > 0) {
    parts.push(`Related words: ${item.words.join(", ")}`);
  }
  if (item.examples && item.examples.length > 0) {
    parts.push(`Reference examples:`);
    for (const ex of item.examples) {
      parts.push(`- ${ex.sentence} (${ex.translation})`);
    }
  }
  parts.push(
    ``,
    `Generate a NEW example sentence in Chinese that demonstrates this grammar point` +
    (item.examples && item.examples.length > 0 ? ` (different from any reference examples)` : ``) +
    `, and translate it to ${langName}.`,
    `Also segment the Chinese sentence into individual words with pinyin (tone marks).`,
    ``,
    `Return JSON: { "chineseSentence": "...", "displaySentence": "...", "segments": [{ "text": "word", "pinyin": "pīnyīn" }, ...] }`,
    `Rules for segments:`,
    `- Segment into natural Chinese words (not individual characters unless standalone)`,
    `- Use tone marks on pinyin (e.g. "nǐ hǎo" not "ni3 hao3")`,
    `- Keep punctuation as separate segments with no pinyin`,
  );

  const raw = await callLLM(
    "You are a Chinese grammar example generator. Follow these steps: 1) Identify the language of the provided description and other fields (they may be in Japanese, English, Korean, or other languages). 2) Understand the grammar point from the provided information. 3) Generate a new Chinese example sentence demonstrating the grammar point. 4) Segment the sentence into words with pinyin. Return valid JSON only.",
    parts.join("\n"),
    "grammar-quiz/generate-sentence"
  );

  const parsed = JSON.parse(stripMarkdownFences(raw));
  let segments: { text: string; pinyin?: string }[] | undefined;

  if (Array.isArray(parsed.segments)) {
    segments = parsed.segments
      .filter((s: { text?: string }) => typeof s?.text === "string" && s.text.length > 0)
      .map((s: { text: string; pinyin?: string }) => ({
        text: s.text,
        ...(typeof s.pinyin === "string" && s.pinyin.length > 0 ? { pinyin: s.pinyin } : {}),
      }));
  }

  // Fallback: if LLM didn't return valid segments, use segmentBatch
  if (!segments || segments.length === 0) {
    const sentence = parsed.chineseSentence ?? "";
    if (sentence) {
      const segMap = await segmentBatch([sentence]);
      segments = segMap.get(0)?.map((s) => ({ text: s.text, pinyin: s.transliteration }));
    }
  }

  return {
    chineseSentence: parsed.chineseSentence ?? "",
    displaySentence: parsed.displaySentence ?? "",
    segments,
  };
}

function weightedSample(
  items: GrammarItemDoc[],
  count: number,
  progressMap: Record<string, GrammarProgress>
): GrammarItemDoc[] {
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

  const selected: GrammarItemDoc[] = [];
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
