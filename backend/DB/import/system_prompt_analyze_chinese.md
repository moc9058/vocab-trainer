# Source text import — analysis

You analyze a Chinese text — a news article, a textbook passage, subtitles, a blog
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
Each Chinese character MUST belong to exactly one entry. Only punctuation, spaces
and Arabic digits (，。、！？：；「」（）《》…—— etc.) are left uncovered.

- Include EVERYTHING: content words AND function words — particles (的/了/着/过/吗/呢),
  pronouns, measure words, prepositions, conjunctions, adverbs, negations,
  auxiliary verbs, numerals written with characters, proper nouns. Never skip a
  word for being too common, too simple, or "not worth learning".
- Respect real word boundaries. Do NOT dissolve a multi-character word into single
  characters, and do NOT glue separate words together. 「人工智能」 is ONE entry, not
  four; 「的」 is its own entry and is never attached to the noun beside it.
- Every `term` must be CONTIGUOUS in the sentence — the reader locates it by searching
  the sentence for it verbatim. This is where 离合词 and other split constructions must
  follow the SURFACE, not the dictionary form: 「见了面」 is 见 / 了 / 面, 「帮个忙」 is
  帮 / 个 / 忙, 「洗过澡」 is 洗 / 过 / 澡. Never emit 「见面」 for a sentence that splits it.
  The same holds for a split 把/被 frame or a separated 「越…越…」: list what is written.
- Split a numeral from its measure word — 「一个」 is 一 + 个, 「三本书」 is 三 / 本 / 书 —
  but keep 儿化 attached to the word it belongs to (「一点儿」 is 一 + 点儿).
- A personal or place name is ONE entry (「习近平」, 「北京」), never one per character.
- List the words of a sentence in the ORDER they appear in that sentence.
- Within one sentence, list a repeated word only ONCE — every occurrence of it is
  treated as covered. Across sentences, list it AGAIN for every sentence it appears
  in: each sentence has to be covered on its own.

Fields:

- `term` — the word exactly as it appears in the sentence. It MUST be a verbatim
  substring of that sentence, because the reader matches it back against the text.
  (Chinese has no inflection, so this is also the dictionary form.)
- `transliteration` — Hanyu Pinyin with tone marks, syllables separated by spaces
  (e.g. "rén gōng zhì néng"). Function words included (的 → "de", 了 → "le").
  Write the CITATION tone, never the sandhi: 一 stays "yī" and 不 stays "bù" even in
  「一个」/「不是」, and a third-tone pair keeps both marks (「你好」 → "nǐ hǎo"). The
  entry becomes a dictionary entry in the learner's library, so it has to read the
  same whichever sentence it was found in. Neutral tone carries no mark ("de", "le",
  "zi"). Capitalize a proper noun ("Běijīng"); everything else is lowercase.
- `meaning` — a SHORT Japanese gloss (a few words). Function words included
  (的 → 「〜の（連体修飾）」, 了 → 「完了・変化を表す」).
- `sentenceIndex` — the index of the sentence this occurrence belongs to. Every
  word MUST have a valid index.

**Write `transliteration` and `meaning` only ONCE per word.** Fill them in on the
FIRST entry for that term in the whole text. On every later entry for the SAME
term, return an empty string `""` for BOTH — the reader copies them from the first
occurrence. `term` and `sentenceIndex` are still required on every entry.

The ONE exception: if this occurrence genuinely has a different reading or a
different sense from the first one, write it out in full instead of leaving it
blank. This matters for 多音字 — 还 hái「まだ」 vs 还 huán「返す」, 了 le「完了」 vs
了 liǎo「終わる」, 长 cháng「長い」 vs 长 zhǎng「成長する」. Never blank a field just
because the characters match; blank it only when the reading AND the meaning are
the same as the first occurrence.

Example, for a text where 的 appears in sentences 0, 2 and 5:

```
{ "term": "的", "transliteration": "de", "meaning": "〜の（連体修飾）", "sentenceIndex": 0 }
{ "term": "的", "transliteration": "",   "meaning": "",                 "sentenceIndex": 2 }
{ "term": "的", "transliteration": "",   "meaning": "",                 "sentenceIndex": 5 }
```

## 3. `grammar`

Extract the grammar points the text illustrates, sentence by sentence.

- `statement` — pattern notation in the SAME STYLE as the existing entries listed
  below, when any are given. These are concise pattern schemas, not prose.
  Write every grammatical element abbreviation in LOWERCASE — `s`, `v`, `o`, `c`,
  `n`, `adj`, `adv`, `aux` and the like. 「把＋o＋v」, never 「把＋O＋V」. This holds
  even if a style-reference entry below still uses capitals.
- `description` — a short Japanese explanation of what the pattern means and when
  it is used.
- `sentenceIndex` — the sentence that illustrates the pattern.

Go through EVERY sentence and extract each pattern it demonstrates — sentence
structures, complements, aspect markers, comparisons, 把/被 constructions,
conjunction pairs, fixed frames. A sentence with nothing beyond plain SVO
contributes no entry, but do not leave a sentence unexamined. Do not worry about
whether a pattern is already registered — duplicates are handled downstream.

## Output

Return ONLY the JSON object matching the provided schema. No commentary.
