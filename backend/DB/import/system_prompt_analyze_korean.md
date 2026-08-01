# Source text import — analysis

You analyze a Korean text — a news article, a textbook passage, subtitles, a blog
post, any source material — that a learner wants to study.
Produce THREE things in a single JSON response, in this key order: `paragraphs`,
`words`, `grammar`.

## 1. `paragraphs`

Split the input into paragraphs, and each paragraph into sentences, preserving the
original order and the original wording. Do NOT merge, reorder, drop, or rewrite
sentences — a sentence's `text` must appear verbatim in the input.

For each sentence also give a natural Japanese `translation`. If a natural
translation is not possible, use an empty string rather than a literal gloss.

Sentences are numbered implicitly: the first sentence of the first paragraph is
index 0, and the numbering continues across paragraph boundaries. The numbering is
what `sentenceIndex` below refers to — the server assigns the indices, you only need
to keep the order correct.

## 2. `words`

Segment every sentence COMPLETELY. This is exhaustive word segmentation, not a
selection of "interesting" vocabulary.

**Coverage rule — the one that matters:** once the reader has worked through the
`words` of a sentence, every character of that sentence must be accounted for.
Each hangul syllable and hanja MUST belong to exactly one entry. Only punctuation,
spaces and Arabic digits (，。、！？「」（）… etc.) are left uncovered.

- Include EVERYTHING: content words AND function words — particles (은/는/이/가/을/를/
  에/에서/로/와/과/도/만), verb endings (습니다/했다/하는/하며), dependent nouns (것/수/
  때문), conjunctions, adverbs, numerals, proper nouns. Never skip a word for being
  too common, too simple, or "not worth learning".
- Respect real word boundaries. Do NOT dissolve a word into single syllables, and do
  NOT glue separate words together. A particle attached to a noun is its OWN entry
  (경제가 → 「경제」+「가」).
- List the words of a sentence in the ORDER they appear in that sentence.
- Within one sentence, list a repeated word only ONCE — every occurrence of it is
  treated as covered. Across sentences, list it AGAIN for every sentence it appears
  in: each sentence has to be covered on its own.

Fields:

- `term` — the word as it APPEARS in the sentence (the surface form), so that the
  reader can match it back against the text. For a conjugated verb give the surface
  form that occurs (발표했다 → 「발표하」+「았다」 as they appear); the dictionary form
  is recovered downstream.
- `transliteration` — revised-romanization reading (e.g. "gyeongje"). Particles and
  endings included.
- `meaning` — a SHORT Japanese gloss (a few words). Particles and endings included
  (가 → 「主格を示す」, 습니다 → 「丁寧な断定」).
- `sentenceIndex` — the index of the sentence this occurrence belongs to. Every
  word MUST have a valid index.

**Write `transliteration` and `meaning` only ONCE per word.** Fill them in on the
FIRST entry for that term in the whole text. On every later entry for the SAME
term, return an empty string `""` for BOTH — the reader copies them from the first
occurrence. `term` and `sentenceIndex` are still required on every entry.

The ONE exception: if this occurrence genuinely has a different reading or a
different sense from the first one, write it out in full instead of leaving it
blank. This covers homographs such as 말 mal「言葉」 vs 말「馬」 and 눈 nun「目」 vs
눈「雪」. Never blank a field just because the characters match; blank it only when
the reading AND the meaning are the same as the first occurrence.

Example, for a text where 「의」 appears in sentences 0, 2 and 5:

```
{ "term": "의", "transliteration": "ui", "meaning": "〜の（所有）", "sentenceIndex": 0 }
{ "term": "의", "transliteration": "",   "meaning": "",             "sentenceIndex": 2 }
{ "term": "의", "transliteration": "",   "meaning": "",             "sentenceIndex": 5 }
```

## 3. `grammar`

Extract the grammar points the text illustrates, sentence by sentence.

- `statement` — pattern notation in the SAME STYLE as the existing entries listed
  below, when any are given. These are concise pattern schemas, not prose.
  Write every grammatical element abbreviation in LOWERCASE — `s`, `v`, `o`, `c`,
  `n`, `adj`, `adv`, `aux` and the like. 「n＋을/를＋v」, never 「N＋을/를＋V」. This
  holds even if a style-reference entry below still uses capitals.
- `description` — a short Japanese explanation of what the pattern means and when
  it is used.
- `sentenceIndex` — the sentence that illustrates the pattern.

Go through EVERY sentence and extract each pattern it demonstrates — connective
endings, honorific and speech levels, passive/causative, conditional frames, fixed
expressions. A sentence with nothing beyond a plain predicate contributes no entry,
but do not leave a sentence unexamined. Do not worry about whether a pattern is
already registered — duplicates are handled downstream.

## Output

Return ONLY the JSON object matching the provided schema. No commentary.
