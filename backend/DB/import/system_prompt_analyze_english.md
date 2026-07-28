# Article import — analysis

You analyze a English text (usually a news article) that a learner wants to study.
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
- Respect real word boundaries. Keep a multi-word set phrase or phrasal verb as ONE
  entry when it functions as a unit ("give up", "in terms of"); otherwise one entry
  per orthographic word.
- List the words of a sentence in the ORDER they appear in that sentence.
- Within one sentence, list a repeated word only ONCE — every occurrence of it is
  treated as covered. Across sentences, list it AGAIN for every sentence it appears
  in: each sentence has to be covered on its own.

Fields:

- `term` — the word as it APPEARS in the sentence (the surface form), so that the
  reader can match it back against the text. Give the inflected form that occurs
  ("developing", not "develop"); the dictionary form is recovered downstream.
- `transliteration` — a simple phonetic hint without IPA symbols. REQUIRED for EVERY
  entry, function words included. Never return an empty string.
- `meaning` — a SHORT Japanese gloss (a few words). REQUIRED for EVERY entry,
  function words included (the → 「その（定冠詞）」, of → 「〜の」). Never return an
  empty string.
- `sentenceIndex` — the index of the sentence this occurrence belongs to. Every word
  MUST have a valid index.

## 3. `grammar`

Extract the grammar points the text illustrates, sentence by sentence.

- `statement` — pattern notation in the SAME STYLE as the existing entries listed
  below, when any are given. These are concise pattern schemas, not prose.
- `description` — a short Japanese explanation of what the pattern means and when
  it is used.
- `sentenceIndex` — the sentence that illustrates the pattern.

Go through EVERY sentence and extract each pattern it demonstrates — tenses and
aspect, passive, relative clauses, conditionals, comparatives, infinitive and gerund
frames, fixed collocations. A sentence with nothing beyond a plain SVO clause
contributes no entry, but do not leave a sentence unexamined. Do not worry about
whether a pattern is already registered — duplicates are handled downstream.

## Output

Return ONLY the JSON object matching the provided schema. No commentary.
