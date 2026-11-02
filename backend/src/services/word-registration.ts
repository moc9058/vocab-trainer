import { resolveWordRegistrationGroups, WordRegistrationGroupError } from '../word-registration-groups.js';
import { normalizeWordDefinitions } from '../word-format.js';
import { contextualDefinitions, sourceContextInstructions } from '../import-definitions.js';
import { languageExists, createLanguage, lookupWordByTerm, lookupWordsByTerms, getWordGroups, getVocabularyConfig } from '../firestore.js';
import { TOPICS, type Example, type HanjaReading } from '../types.js';
import { generateHanjaReadings } from '../hanja.js';
import { callLLM, stripMarkdownFences, fillSegmentPinyin, type Segment } from '../llm.js';
import { ALL_DEFINITION_LANGUAGES, LANGUAGE_TO_ISO, translationIsEmpty } from '../exampleTranslations.js';
import type { FastifyBaseLogger as Logger } from 'fastify';
export class PreparationError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
const LEVEL_OPTIONS: Record<string, string[]> = {
  chinese: ["HSK1-4", "HSK5", "HSK6", "HSK7-9", "Advanced"],
  japanese: ["JLPT5", "JLPT4", "JLPT3", "JLPT2", "JLPT1", "Advanced"],
};

// Map any granular HSK label the LLM (or a user) might emit onto the unified
// buckets above. The LLM is instructed to use the buckets directly in the
// prompt, but it sometimes slips back to "HSK2" etc. — this is the guarantee.
const CHINESE_LEVEL_NORMALIZE: Record<string, string> = {
  HSK1: "HSK1-4",
  HSK2: "HSK1-4",
  HSK3: "HSK1-4",
  HSK4: "HSK1-4",
  "HSK1-extended": "HSK1-4",
  "HSK2-extended": "HSK1-4",
  "HSK3-extended": "HSK1-4",
  "HSK4-extended": "HSK1-4",
  "HSK1-4": "HSK1-4",
  HSK5: "HSK5",
  "HSK5-extended": "HSK5",
  HSK6: "HSK6",
  "HSK6-extended": "HSK6",
  HSK7: "HSK7-9",
  HSK8: "HSK7-9",
  HSK9: "HSK7-9",
  "HSK7-9": "HSK7-9",
  "HSK7-9-extended": "HSK7-9",
  Advanced: "Advanced",
};

function normalizeLevel(language: string, level: string): string {
  if (!level) return "";
  if (language === "chinese") return CHINESE_LEVEL_NORMALIZE[level] ?? level;
  return level;
}

const ALLOWED_LANGUAGES = new Set(Object.keys(LANGUAGE_TO_ISO));

function fillPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}


export interface WordRegistrationInput { term: string; sourceContext?: import("../types.js").ImportSourceContext; transliteration?: string; definitions?: import("../types.js").WordMeaning[]; topics?: string[]; examples?: { sentence: string; translation: string | Record<string,string>; userSplits?: string[] }[]; level?: string; notes?: string; groupIds?: string[]; groupBIds?: string[] }
export async function prepareWordRegistration(language: string, body: WordRegistrationInput, log: Logger) {
const vocabConfig = await getVocabularyConfig();
      if (!(await languageExists(language))) {
        await createLanguage(language);
      }

      const term = body.term.trim();
      if (!term) throw new PreparationError(400, "Term is required");

      // Check if word already exists
      const existing = await lookupWordByTerm(language, term);
      if (existing) {
        throw new PreparationError(409, `Word '${term}' already exists in the database`);
      }

      const registrationGroups = { groupIds: body.groupIds, groupBIds: body.groupBIds };
      try {
        resolveWordRegistrationGroups(language, await getWordGroups(language), registrationGroups);
      } catch (err) {
        if (err instanceof WordRegistrationGroupError) throw new PreparationError(400, err.message);
        throw err;
      }

      // Build LLM prompt — definitions are always requested in all four
      // supported languages, but example translations exclude the source
      // language (a same-language "translation" of an example sentence is
      // redundant). Display filtering happens client-side via settings.
      const isChinese = language === "chinese";
      const sourceLangCode = LANGUAGE_TO_ISO[language]; // undefined for custom languages
      const exampleTranslationLanguages = ALL_DEFINITION_LANGUAGES.filter(
        (l) => l !== sourceLangCode
      );
      const defLangStr = ALL_DEFINITION_LANGUAGES.map((l) => `"${l}": "..."`).join(", ");
      const exTranslationSpec = `"translation": { ${exampleTranslationLanguages
        .map((l) => `"${l}": "..."`)
        .join(", ")} }`;

      const langLevels = LEVEL_OPTIONS[language];
      const userInput: Record<string, unknown> = { term };
      if (isChinese) {
        userInput.transliteration = body.transliteration || null;
      }
      userInput.definitions = (body.definitions && body.definitions.length > 0)
        ? normalizeWordDefinitions(body) : null;
      userInput.topics = (body.topics && body.topics.length > 0)
        ? body.topics : null;
      // Empty translations (chip adds send `""`) become null so the LLM
      // treats them as missing and generates them, instead of echoing "".
      userInput.examples = (body.examples && body.examples.length > 0)
        ? body.examples.map(({ sentence, translation }) => ({
            sentence,
            translation: translationIsEmpty(translation as Example["translation"]) ? null : translation,
          })) : null;
      if (langLevels) {
        userInput.level = body.level || null;
      }
      userInput.notes = body.notes || null;
      if (body.sourceContext) userInput.sourceContext = body.sourceContext;

      const promptTemplate = vocabConfig.smartAddPrompts[language]
        ?? vocabConfig.smartAddPrompts["default"];
      let systemPrompt = fillPlaceholders(promptTemplate, {
        LANGUAGE: language,
        DEFINITION_LANGUAGES: defLangStr,
        EXAMPLE_TRANSLATION_SPEC: exTranslationSpec,
        TOPICS: TOPICS.join(", "),
        LEVELS: langLevels?.join(", ") ?? "",
        LEVEL_FIELD: langLevels ? `\n  "level": "one of the allowed levels",` : "",
        LEVELS_LINE: langLevels ? `\nAllowed levels: ${langLevels.join(", ")}` : "",
      });

      if (body.sourceContext) systemPrompt += sourceContextInstructions(body.sourceContext);
      const userPrompt = JSON.stringify(userInput, null, 2);

      let llmResult: Record<string, unknown>;
      try {
        const raw = await callLLM({ system: systemPrompt, user: userPrompt, schema: vocabConfig.smartAddSchema, route: "vocab/smart-add" });
        llmResult = JSON.parse(stripMarkdownFences(raw));
      } catch (err) {
        log.error({ err, term }, "LLM call failed for smart-add");
        throw new PreparationError(502, "Failed to generate word data");
      }

      // Merge: user-provided fields take priority; definitions & examples get supplemented
      const userDefs = normalizeWordDefinitions(body);
      const userDefCount = userDefs.length;
      const generatedDefs = (llmResult.definitions ?? []) as (import("../types.js").WordMeaning & {
        inputDefinitionIndex?: number | null; distinctSenseReason?: string; contrastExample?: string;
      })[];
      const userExCount = body.examples?.length ?? 0;
      const llmExamples = (llmResult.examples as { sentence: string; translation: string }[]) || [];

      const llmDefs = body.sourceContext && userDefs.length > 0
        ? contextualDefinitions(generatedDefs, userDefs) : normalizeWordDefinitions(llmResult);

      if (body.sourceContext && userDefs.length > 0 && llmDefs.slice(0, userDefs.length).some((def, index) =>
        ALL_DEFINITION_LANGUAGES.some(code => !(def.text?.[code]?.trim() || userDefs[index]?.text?.[code]?.trim())))) {
        throw new PreparationError(502, "Generated definitions did not preserve the supplied meanings in every language. Please retry.");
      }

      // For each user-provided definition, keep the user's text in whatever
      // languages they supplied, and fill in the missing-language entries from
      // the LLM's same-index definition (the LLM is instructed to translate the
      // user's meaning into every required language code).
      const mergedUserDefs = userDefs.map((userDef, i) => {
        const llmDef = llmDefs[i];
        const mergedText: Record<string, string> = { ...(llmDef?.text ?? {}) };
        for (const [lang, text] of Object.entries(userDef.text ?? {})) {
          if (text && text.trim()) mergedText[lang] = text;
        }
        const pinyins = (userDef as any).pinyins?.length > 0
          ? (userDef as any).pinyins
          : (llmDef?.pinyins && llmDef.pinyins.length > 0 ? llmDef.pinyins : undefined);
        return {
          text: mergedText,
          ...(pinyins ? { pinyins } : {}),
        };
      });

      const merged = {
        term,
        transliteration: isChinese ? (body.transliteration || (llmResult.transliteration as string) || "") : undefined,
        definitions: userDefCount > 0
          ? [...mergedUserDefs, ...llmDefs.slice(userDefCount)]
          : llmDefs.length > 0 ? llmDefs : [{ text: { en: "" } }],
        examples: userExCount > 0
          ? [
              ...body.examples!.map((ex, i) => {
                const llmEx = llmExamples[i];
                const hasTranslation = typeof ex.translation === "string"
                  ? ex.translation.trim() !== ""
                  : ex.translation != null && Object.keys(ex.translation).length > 0;
                const merged = hasTranslation
                  ? ex
                  : llmEx?.translation ? { ...ex, translation: llmEx.translation } : ex;
                // Carry over LLM-generated segments for user-provided examples
                const llmSegs = (llmEx as any)?.segments;
                if (llmSegs && !(merged as any).segments) {
                  return { ...merged, segments: llmSegs };
                }
                return merged;
              }),
              ...llmExamples.slice(userExCount),
            ]
          : llmExamples,
        topics: (body.topics && body.topics.length > 0)
          ? body.topics
          : ((llmResult.topics as string[]) || []).filter((t) => (TOPICS as readonly string[]).includes(t)),
        level: langLevels
          ? normalizeLevel(language, body.level || (llmResult.level as string) || "")
          : "",
        notes: body.notes || (llmResult.notes as string) || "",
      };

      // Ensure at least one valid topic
      if (merged.topics.length === 0) {
        merged.topics = ["Language Fundamentals"];
      }

      // Korean hanja readings, for Chinese words only. Started here and awaited
      // just before the word doc is built, so it runs alongside the example-sentence
      // writes instead of adding its own round-trip to the request. A failure is
      // logged and dropped: the word is worth more than its readings, and
      // `backfill-hanja-readings.ts` can fill in what is missing later.
      const hanjaPromise: Promise<HanjaReading[] | undefined> = isChinese
        ? generateHanjaReadings(merged.term, merged.transliteration).catch((err) => {
            log.error({ err, term }, "hanja reading generation failed");
            return undefined;
          })
        : Promise.resolve(undefined);

      // Parse segments from LLM response (Chinese only — segments are included in Call 1)
      const examplesWithSegments: Example[] = merged.examples.map((ex: any) => {
        if (!isChinese) {
          // Non-Chinese words must not carry segments at all: the schema still
          // exposes the key, and a stray LLM- or client-sent array would get
          // seg.id stamped and reconciled into appearsInIds links that no
          // non-Chinese code path maintains afterwards.
          const { segments: _drop, ...rest } = ex;
          return rest as Example;
        }
        if (!Array.isArray(ex.segments)) return ex as Example;
        const segments: Segment[] = [];
        for (const seg of ex.segments) {
          if (typeof seg?.text !== "string" || seg.text.length === 0) continue;
          const py = seg.pinyin ?? seg.transliteration;
          if (typeof py === "string" && py.length > 0) {
            segments.push({ text: seg.text, transliteration: py });
          } else {
            segments.push({ text: seg.text });
          }
        }
        return { sentence: ex.sentence, translation: ex.translation, segments } as Example;
      });

      // For user-provided Chinese examples with userSplits, override LLM segments with
      // the user's splits + LLM-filled pinyin.
      if (isChinese && userExCount > 0) {
        const fillItems: Array<{ index: number; sentence: string; splits: string[] }> = [];
        for (let i = 0; i < userExCount; i++) {
          const us = (body.examples![i] as any).userSplits as string[] | undefined;
          if (Array.isArray(us) && us.length > 0) {
            fillItems.push({ index: i, sentence: examplesWithSegments[i].sentence, splits: us });
          }
        }
        if (fillItems.length > 0) {
          const fillMap = await fillSegmentPinyin(
            fillItems.map((fi) => ({ sentence: fi.sentence, splits: fi.splits })),
          );
          for (let j = 0; j < fillItems.length; j++) {
            const rawSegs = fillMap.get(j);
            if (rawSegs) (examplesWithSegments[fillItems[j].index] as any).segments = rawSegs;
          }
        }
      }

      // Strip the source language from example translations and definitions:
      // a same-language translation/definition is redundant for the word's own language.
      if (sourceLangCode) {
        for (const ex of examplesWithSegments) {
          if (ex.translation && typeof ex.translation === "object") {
            delete (ex.translation as Record<string, string>)[sourceLangCode];
          }
        }
        for (const def of merged.definitions as { text: Record<string, string> }[]) {
          if (def.text && typeof def.text === "object") {
            // Keep the own-language gloss when it is all the definition has:
            // stripping it would store `text: {}` (the en-only fallback above
            // hits this for English words). A redundant gloss beats an empty
            // definition.
            const hasOther = Object.entries(def.text).some(
              ([lang, text]) => lang !== sourceLangCode && text && text.trim() !== "",
            );
            if (hasOther) delete def.text[sourceLangCode];
          }
        }
      }

      // Link segments to existing words in DB
      const allSegmentTexts = [
        ...new Set(
          examplesWithSegments.flatMap(ex => ex.segments?.map(s => s.text) ?? [])
        ),
      ];
      if (allSegmentTexts.length > 0) {
        const matches = await lookupWordsByTerms(language, allSegmentTexts);
        const termToId = new Map(matches.map(m => [m.term, m.id]));
        for (const ex of examplesWithSegments) {
          if (!ex.segments) continue;
          for (const seg of ex.segments) {
            const wordId = termToId.get(seg.text);
            if (wordId) seg.id = wordId;
          }
        }
      }


return { merged, examplesWithSegments, registrationGroups, hanjaReadings: await hanjaPromise };
}
