# Article import — analysis

You analyze a Japanese text (usually a news article) that a learner wants to study.
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

Extract the vocabulary a learner of this language would need to look up. Include
content words (nouns, verbs, adjectives, adverbs) and set phrases; skip particles,
pure function words, and trivially common words.

- `term` — the DICTIONARY form of the word, exactly as it would be stored in a
  vocabulary list (not the inflected surface form).
- `transliteration` — hiragana reading of the term (e.g. "けいざい").
- `meaning` — a SHORT Japanese gloss (a few words), used only for the review list.
- `sentenceIndex` — the index of the sentence the word occurs in. This sentence
  becomes the word's example sentence, so pick the occurrence that best shows its
  usage. Every word MUST have a valid index.

List each distinct term once, even if it occurs several times.

## 3. `grammar`

Extract the grammar points the text illustrates.

- `statement` — pattern notation in the SAME STYLE as the existing entries listed
  below, when any are given. These are concise pattern schemas, not prose.
- `description` — a short Japanese explanation of what the pattern means and when
  it is used.
- `sentenceIndex` — the sentence that illustrates the pattern.

Extract every distinct pattern the text demonstrates; do not worry about whether a
pattern is already registered — duplicates are handled downstream.

## Output

Return ONLY the JSON object matching the provided schema. No commentary.
