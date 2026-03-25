import type { FastifyPluginAsync } from "fastify";
import {
  getAllGrammarItems,
  getGrammarItem,
  getGrammarProgressForLanguage,
  getGrammarComponentProgress,
  updateGrammarComponentProgress,
  getGrammarQuizSession,
  saveGrammarQuizSession,
  type GrammarItemDoc,
} from "../firestore.js";
import type { GrammarQuizSession, GrammarQuizQuestion, GrammarProgress } from "../types.js";
import { callLLM, stripMarkdownFences } from "../llm.js";

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  kr: "Korean",
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
};

async function prepareQuestion(
  item: GrammarItemDoc,
  displayLanguage: string,
  mode: string
): Promise<{ displaySentence: string; chineseSentence: string }> {
  const langName = LANG_NAMES[displayLanguage] || "Japanese";

  if (mode === "existing" && item.examples && item.examples.length > 0) {
    // Pick a random example
    const ex = item.examples[Math.floor(Math.random() * item.examples.length)];
    const chineseSentence = ex.sentence;

    // Check if translation exists in display language
    // The example.translation is typically in English; we may need to generate for other languages
    if (ex.translation) {
      // If display language is English, we can use the translation directly
      if (displayLanguage === "en") {
        return { displaySentence: ex.translation, chineseSentence };
      }
      // For other languages, try to use LLM to translate
      const raw = await callLLM(
        "You are a translator. Return valid JSON only.",
        `Translate the following sentence to ${langName}. Return JSON: { "translation": "..." }

Sentence: ${ex.translation}`
      );
      const parsed = JSON.parse(stripMarkdownFences(raw));
      return { displaySentence: parsed.translation ?? ex.translation, chineseSentence };
    }
    // No translation at all — generate via LLM
    return await generateSentencePair(item, langName);
  }

  // LLM mode or no examples available — generate fresh
  return await generateSentencePair(item, langName);
}

async function generateSentencePair(
  item: GrammarItemDoc,
  langName: string
): Promise<{ displaySentence: string; chineseSentence: string }> {
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
    ``,
    `Return JSON: { "chineseSentence": "...", "displaySentence": "..." }`
  );

  const raw = await callLLM(
    "You are a Chinese grammar example generator. Return valid JSON only.",
    parts.join("\n")
  );

  const parsed = JSON.parse(stripMarkdownFences(raw));
  return {
    chineseSentence: parsed.chineseSentence ?? "",
    displaySentence: parsed.displaySentence ?? "",
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
