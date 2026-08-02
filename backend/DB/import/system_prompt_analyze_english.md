# Source text import — analysis

You analyze a English text — a news article, a textbook passage, subtitles, a blog
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

Segment every sentence COMPLETELY. This is exhaustive tokenization, not a selection
of "interesting" vocabulary.

**Coverage rule — the one that matters:** once the reader has worked through the
`words` of a sentence, every character of that sentence must be accounted for. Each
letter MUST belong to exactly one entry. Only punctuation, spaces and digits
(, . ! ? ; : " ' ( ) — … etc.) are left uncovered.

- Include EVERYTHING: content words AND function words — articles (a/an/the),
  prepositions, pronouns, auxiliaries (is/have/will/would), conjunctions, particles
  of phrasal verbs, numerals written as words, proper nouns. Never skip a word for
  being too common, too simple, or "not worth learning".
- One entry per orthographic word by default. A multi-word entry is allowed ONLY when
  its words are ADJACENT in the sentence, in that exact order, with nothing between
  them — the reader locates every entry by searching the sentence for it verbatim.
  "in terms of", and "gave up" in "we gave up", are fine. A SEPARATED phrasal verb is
  not: for "gave it up" or "turn the light on", list the parts as separate entries
  ("gave" / "it" / "up"). Never write the dictionary form of a phrase that the
  sentence splits.
- Keep a contraction or a possessive whole — "don't", "it's", "we've", "company's".
  Never emit a bare "n't" or "'s": they cannot be located on their own and leave the
  rest of the sentence uncovered.
- Keep a hyphenated compound whole — "state-of-the-art", "well-known".
- A single-word entry may be given in any case (it is matched case-insensitively), but
  a MULTI-word entry must copy the sentence's own capitalization exactly.
- A number written in digits ("2024", "15%") needs no entry; a number written in words
  ("fifteen", "third") does.
- List the words of a sentence in the ORDER they appear in that sentence.
- Within one sentence, list a repeated word only ONCE — every occurrence of it is
  treated as covered. Across sentences, list it AGAIN for every sentence it appears
  in: each sentence has to be covered on its own.

Fields:

- `term` — the word as it APPEARS in the sentence (the surface form), so that the
  reader can match it back against the text. Give the inflected form that occurs
  ("developing", not "develop"); the dictionary form is recovered downstream. A
  multi-word `term` must be a contiguous substring of the sentence.
- `transliteration` — a KATAKANA reading of the word as it is pronounced here, no IPA
  and no romaji ("the" → 「ザ」, "of" → 「オブ」, "developing" → 「ディベロピング」).
  Function words included. Where one spelling has two pronunciations, see the
  exception below.
- `meaning` — a SHORT Japanese gloss (a few words). Function words included
  (the → 「その（定冠詞）」, of → 「〜の」).
- `sentenceIndex` — the index of the sentence this occurrence belongs to. Every word
  MUST have a valid index.

**Write `transliteration` and `meaning` only ONCE per word.** Fill them in on the
FIRST entry for that term in the whole text. On every later entry for the SAME
term, return an empty string `""` for BOTH — the reader copies them from the first
occurrence. `term` and `sentenceIndex` are still required on every entry.

The ONE exception: if this occurrence genuinely has a different pronunciation or a
different sense from the first one, write it out in full instead of leaving it
blank. English needs this for homographs — "lead" (to guide) vs "lead" (the metal),
"read" (present) vs "read" (past), "close" (near) vs "close" (to shut). Never blank
a field just because the spelling matches; blank it only when the pronunciation AND
the meaning are the same as the first occurrence.

Example, for a text where "the" appears in sentences 0, 2 and 5:

```
{ "term": "the", "transliteration": "ザ", "meaning": "その（定冠詞）", "sentenceIndex": 0 }
{ "term": "the", "transliteration": "",   "meaning": "",              "sentenceIndex": 2 }
{ "term": "the", "transliteration": "",   "meaning": "",              "sentenceIndex": 5 }
```

## 3. `grammar`

Extract the grammar points the text illustrates, sentence by sentence.

- `statement` — pattern notation in the SAME STYLE as the existing entries listed
  below, when any are given. These are concise pattern schemas, not prose.
  Write every grammatical element abbreviation in LOWERCASE — `s`, `v`, `o`, `c`,
  `n`, `adj`, `adv`, `aux` and the like. `s + v + o`, never `S + V + O`. This holds
  even if a style-reference entry below still uses capitals.
- `description` — a short Japanese explanation of what the pattern means and when
  it is used.
- `sentenceIndex` — the sentence that illustrates the pattern.

Go through EVERY sentence and extract each pattern it demonstrates — tenses and
aspect, passive, modality, relative clauses, conditionals, comparatives, infinitive
and gerund frames, participle clauses, existential `there + be`, it-clefts, and fixed
collocations. A sentence with nothing beyond a plain SVO clause
contributes no entry, but do not leave a sentence unexamined. Do not worry about
whether a pattern is already registered — duplicates are handled downstream.

## Output

Return ONLY the JSON object matching the provided schema. No commentary.
