# 중국어 단어·문법 외부 등록 요청 v1

정의일: 2026-11-02. 같은 날 문법 설명 입력을 `ko` 또는 `ja`로 확장했다. AI 또는 외부 프로그램이 **현재 HTTP API로 본등록할 때 보낼 정보**를 정의한다. 요청 본문은 UTF-8 JSON이며 한 요청에 한 항목을 등록한다. `smart-add`는 서버의 LLM으로 부족한 정보를 보완하므로 완성된 데이터를 보내도 LLM 호출이 발생한다.

| 종류 | 메서드·경로 | 최소 필수 정보 | 프로그램용 요청 스키마 |
|---|---|---|---|
| 단어 | `POST /api/vocab/chinese/smart-add` | `term` | [단어 JSON Schema](chinese-word-create.v1.schema.json) |
| 문법 | `POST /api/grammar/chinese/smart-add` | `id`, `statement`, `descriptions` | [문법 JSON Schema](chinese-grammar-create.v1.schema.json) |

스키마의 v1은 이 문서의 요청 규약 버전이다. URL이나 본문에 `v1` 또는 `version`을 추가하지 않는다. 스키마는 외부 클라이언트가 생성·검증할 권장 형식으로, 현재 서버보다 엄격하게 잘못된 필드와 빈 설명을 거부한다. 서버에 새 검증기나 새 엔드포인트를 설치하는 작업과는 구분한다. `$id`의 `vocab-trainer.local`은 스키마 식별자이며 접속할 서버 주소가 아니다.

## 공통 전송 정보

```http
Content-Type: application/json
Authorization: Bearer <사용자 승인으로 발급받은 ext_ 토큰>
```

운영 base URL은 `https://vocab-trainer-frontend-olncevthqa-an.a.run.app`이다. 예를 들어 단어 등록 URL은 base URL에 `/api/vocab/chinese/smart-add`를 붙인다. 클라이언트 설정으로 base URL을 교체할 수 있게 한다.

- 학습 언어는 URL의 `chinese`로 지정한다. 본문에는 `language`를 보내지 않는다.
- 정의·설명·번역의 언어 키는 `ko`, `ja`, `en`, `zh` 같은 ISO 코드이다. `korean`, `japanese`를 쓰지 않는다.
- 단어의 품사·카테고리(`partOfSpeech`, `grammaticalCategory`)와 리뷰 플래그(`flag`, `flaggedOnly`, `flagWordIds`)는 보내지 않는다. 문법 설명의 호환 필드 `partOfSpeech`는 아래처럼 빈 문자열로 보낸다.
- 예문은 중국어 원문과 번역을 보낸다. `translation`은 문자열 또는 ISO 코드별 객체이다. 번역을 서버에 맡길 때는 `""`로 보낸다.
- 단어는 `smart-add` 요청의 `groupIds`·`groupBIds`로 그룹까지 함께 등록한다. A 그룹 생략 시 가장 최근에 생성한 A 그룹으로 자동 배정한다. 문법 그룹은 등록 후 별도 요청으로 추가한다.
- 서버가 관리하는 예문 ID·역참조·진도·점수·한자 독음 자료는 보내지 않는다. 이 규약에서는 `exampleIds`, `appearsInIds`, `hanjaReadings`, 문법의 `words`도 입력에서 제외한다.

## 단어 요청

최소 요청:

```json
{
  "term": "后悔"
}
```

뜻과 예문을 제공하는 권장 요청:

```json
{
  "term": "后悔",
  "transliteration": "hòuhuǐ",
  "definitions": [
    {
      "text": { "ko": "후회하다" },
      "pinyins": ["hòuhuǐ"]
    }
  ],
  "examples": [
    {
      "sentence": "现在后悔也来不及了。",
      "translation": { "ko": "이제 후회해도 늦었다." }
    }
  ]
}
```

| 필드 | 필수 | 의미·처리 |
|---|---|---|
| `term` | 예 | 중국어 단어 또는 표현. 앞뒤 공백을 제거하고 보낸다. 단어 ID는 서버가 생성한다. |
| `transliteration` | 아니요 | 단어 전체의 성조 부호가 있는 병음(피닌). 생략하면 생성한다. |
| `definitions` | 아니요 | 서로 다른 의미의 배열. 각 항목은 `text`와 선택적인 `pinyins`만 가진다. |
| `definitions[].text` | 정의를 보낼 때 | `ko`·`ja`·`en` 중 한 언어 이상으로 뜻을 제공한다. 서버는 부족한 언어를 보완하고 중국어 자체 정의(`zh`)는 저장하지 않는다. |
| `definitions[].pinyins` | 아니요 | 해당 의미에 대응하는 발음 배열. 다의·다음자를 구분할 때 사용한다. |
| `examples` | 아니요 | `{ sentence, translation, userSplits? }[]`. 생략하면 서버가 예문을 생성할 수 있다. |
| `examples[].userSplits` | 아니요 | 예문의 단어 경계를 지정하는 문자열 배열. 예문을 바꾸지 않고 원문 순서대로 분할한다. 서버가 발음과 단어 참조를 보완한다. 본등록의 필드명은 하단의 초안용 `segments`와 다르다. |
| `level` | 아니요 | `HSK1-4`, `HSK5`, `HSK6`, `HSK7-9`, `Advanced` 중 하나. 생략하면 서버가 정한다. |
| `topics` | 아니요 | 기존 `TOPICS` 값의 배열. 임의의 분류명을 만들지 말고, 필요 없으면 생략한다. |
| `notes` | 아니요 | 보충 메모. |
| `groupIds` | 아니요 | 같은 언어의 단어 그룹 ID 배열(최대 100개). A 그룹은 최대 하나만 지정한다. 기존 클라이언트 호환을 위해 B 그룹 ID를 함께 넣어도 된다. A를 지정하지 않으면 가장 최근 생성된 A 그룹을 자동 선택한다. |
| `groupBIds` | 아니요 | 추가 배정할 B **단어** 그룹 ID 배열(최대 100개). 지정한 B 그룹 모두에 소속된다. 문법 그룹 ID나 A 그룹 ID를 넣으면 `400`이다. |
| `sourceContext` | 아니요 | 읽은 문장에서 추출한 경우의 문맥. 아래 4개 필드를 모두 제공한다. |

`sourceContext`는 `{ sentence, surface, contextualMeaning, explanationLanguage }`이다. `sentence`는 원문 문장(최대 8,000자), `surface`는 그 문장에 실제로 나타난 표현, `contextualMeaning`은 그 문장에서의 뜻(최대 2,000자), `explanationLanguage`는 그 뜻의 언어(`ko`/`ja`/`en`/`zh`)이다. 이 정보는 뜻 보완에 쓰이며 출처 문서나 영구 출처 메타데이터를 생성하는 기능은 아니다.

## 문법 요청

```json
{
  "id": "grammar-chinese-f6c2e6bc-3189-42e1-93e9-93aefda6c915",
  "statement": "把+O+V",
  "transliteration": "bǎ+O+V",
  "descriptions": [
    {
      "partOfSpeech": "",
      "text": {
        "ko": "목적어를 把 뒤, 동사 앞에 놓아 그 대상에 대한 처리나 결과를 나타낸다."
      }
    }
  ],
  "examples": [
    {
      "sentence": "我把书放在桌子上了。",
      "translation": { "ko": "나는 책을 책상 위에 놓았다." }
    }
  ],
  "level": "HSK4",
  "tags": ["把字句"]
}
```

| 필드 | 필수 | 의미·처리 |
|---|---|---|
| `id` | 예 | 현재 API는 클라이언트가 ID를 지정한다. 새 항목마다 `grammar-chinese-<소문자 UUID v4>`를 생성한다. 위 예시 ID를 실제 등록에 재사용하지 않는다. |
| `statement` | 예 | 중국어 문법 패턴. 구조·자리표시자는 `+`, `…`, `O`, `V` 등으로 표현한다. |
| `descriptions` | 예 | 비어 있지 않은 설명 배열. 각 항목은 `{ partOfSpeech: "", text: { ko: "..." }, pinyins? }`처럼 보낸다. `text`에는 `ko` 또는 `ja` 중 하나 이상의 설명을 제공한다. |
| `descriptions[].text` | 예 | `ko` 또는 `ja` 중 한 언어 이상. 한국어만 보내도 등록할 수 있다. 입력한 설명은 그대로 보존하고, 부족한 일본어·한국어 설명은 같은 의미로 생성해 함께 저장한다. 서버는 추가로 입력된 다른 언어의 설명도 보존하지만 이 v1 외부 요청 스키마는 `ko`·`ja`만 정의한다. |
| `transliteration` | 아니요 | 중국어 부분만 성조 부호가 있는 소문자 병음(피닌)으로 적고 기호·비중국어 자리표시자는 유지한다(예: `能(/可以)+v` → `néng(/kěyǐ)+v`). 경성에는 성조 부호를 붙이지 않는다. 생략하면 서버가 생성을 시도한다. 생성에 실패해도 문법 등록은 성공할 수 있다. |
| `examples` | 아니요 | 단어와 같은 예문 입력 형식. 예문은 공용 예문 문서로 저장되고 응답의 `exampleIds`로 연결된다. |
| `level` | 아니요 | 문법 레벨 문자열. 예: `HSK4`. 단어의 통합 레벨 목록과 혼동하지 않는다. |
| `tags` | 아니요 | 문법 태그 문자열 배열. |

문법 smart-add 응답의 `descriptions[].text`에는 일본어(`ja`)와 한국어(`ko`)가 포함된다. 생성 결과가 부족하면 저장 전에 `502`로 실패하므로 빈 설명이 있는 항목을 성공으로 표시하지 않는다. 기존 저장 항목은 일괄 번역하지 않으며, 한국어 표시 여부는 앱 설정의 문법 설명 표시 언어를 따른다.

문법 `smart-add`는 기존 `id`와 충돌하면 해당 문서를 덮어쓸 수 있다. 같은 `statement`의 중복도 자동으로 막지 않는다. ID는 멱등성 키가 아니며, 새 문법 요청을 무조건 재시도하는 방식으로 사용하지 않는다.

## 그룹 등록과 성공 확인

### 단어: 등록 요청에서 A/B를 함께 배정

```json
{
  "term": "后悔",
  "groupIds": ["REPLACE_WITH_A_WORD_GROUP_ID"],
  "groupBIds": ["REPLACE_WITH_B_WORD_GROUP_ID"]
}
```

예시 ID는 `GET /api/vocab/chinese/groups`에서 조회한 실제 단어 그룹 ID로 바꾼다. 그룹의 `category`가 생략되었으면 A, `"B"`이면 B이다.

- `groupIds`·`groupBIds`를 모두 생략하거나 빈 배열로 보내면 A 그룹에 자동 등록된다. 기본값은 **`createdAt`이 가장 최근인 A 그룹**이며, 화면의 맨 아래 항목이나 드래그 우선순위가 아니다. 생성일이 같으면 그룹 ID 내림차순으로 결정한다.
- `groupBIds`만 보내도 기본 A 그룹과 지정한 B 그룹들에 모두 등록된다. `groupIds`에 B만 넣은 경우도 같다.
- 명시적으로 A 그룹을 지정하면 그 그룹을 사용한다. A 그룹을 둘 이상 지정하거나, 존재하지 않는 그룹·다른 언어 그룹을 지정하면 `400`이다. 중복 ID는 한 번만 배정한다.
- A 그룹이 하나도 없으면 `400`이며 단어를 생성하지 않는다. 먼저 A 단어 그룹을 만든다. 이 API는 임의의 이름으로 기본 그룹을 만들지 않는다.
- 서버가 저장 직전에 그룹을 다시 확인한다. 생성 중에 새 A 그룹이 추가되면 생략된 A 기본값은 그 최신 그룹을 따른다. 명시한 그룹이 삭제되었다면 단어·인덱스·소속이 일부만 저장되지 않도록 등록을 실패시킨다.
- 단어 문서, 단어 인덱스, A/B 그룹 소속과 최근 추가 시각은 한 Firestore 트랜잭션으로 저장한다. 그룹 소속은 그룹 문서의 `wordIds[]`가 소유하며 단어 문서에 `groupIds`를 저장하지 않는다.

`201` 응답은 기존과 같은 `Word`이며 생성된 `id`를 기록하면 된다. 별도 그룹 추가 요청은 필요 없다. 이후 기존 단어를 다른 그룹에 넣으려면 `POST /api/vocab/chinese/groups/{groupId}/words`에 `{ "wordIds": ["기존 단어 ID"], "action": "add" }`를 보낸다. 단어 등록 `409`는 기존 단어의 소속을 자동 변경하지 않는다.

웹 화면이 A 그룹을 명시적으로 선택해 보낸 경우에는 그 선택을 존중한다. 화면의 기존 기본 선택은 우선순위 기반이며, **서버가 A 지정을 생략한 요청을 처리하는 기본값**과 구분한다.

### 문법: 등록 후 별도 그룹 추가

1. 문법 등록의 `201` 응답에서 `id`를 기록한다. 응답은 `Grammar` 및 `exampleIds`이며 서버가 보완한 내용을 포함한다.
2. `GET /api/grammar/chinese/groups`에서 실제 문법 그룹 ID를 선택한다.
3. `POST /api/grammar/chinese/groups/{groupId}/grammar`에 `{ "grammarIds": ["등록된 문법 ID"], "action": "add" }`를 보낸다.

문법은 A 그룹도 여러 개에 속할 수 있다. 같은 이름의 단어·문법 B 그룹이라도 실제 ID는 서로 다르므로 각각 조회한다. 문법 그룹 미지정 시 이 API에서 자동 등록하지 않는다. 문법 생성과 그룹 추가는 별도 작업이므로 그룹 추가가 실패했으면 생성된 `id`를 유지한 채 소속 추가만 재시도한다.

## 중복·오류·인증

| 결과 | 클라이언트 처리 |
|---|---|
| `201` | 생성된 ID와 응답을 기록한다. 단어는 A/B 소속까지 저장 완료된 상태이며, 문법은 필요한 그룹 소속을 별도 추가한다. |
| `400` | JSON·필수 정보·필드 형식과 단어 그룹 ID를 확인한다. 기본 A 그룹이 없으면 먼저 만든다. |
| `401` / `403` | 각각 인증 또는 권한을 확인한다. 등록 성공으로 표시하지 않는다. |
| 단어 등록 `409` | 새 단어를 반복 생성하지 않는다. `POST /api/vocab/chinese/check-terms`에 `{ "terms": ["后悔"] }`를 보내 `{ "existing": { "后悔": "기존 ID" } }`를 확인한 뒤 기존 단어 사용 여부를 결정한다. 기존 뜻을 자동 덮어쓰지 않는다. |
| `429`, `5xx`, 통신 끊김·타임아웃 | 저장 성공 여부가 불명확할 수 있다. 생성 POST를 무조건 재전송하지 않는다. 단어는 `check-terms`, 문법은 기록한 ID와 조회 가능 권한으로 먼저 확인한다. |

현재 외부 연동 인증에는 사용자 승인형 extension 토큰을 사용할 수 있다. `/api/auth/extension/start` → 사용자 웹 승인 → `/api/auth/extension/exchange`를 통해 발급하며 토큰은 30일 동안 유효하다. 상시 공용 API 키나 무승인 서버 간 인증을 정의한 것은 아니다. 연결 절차는 [Safari 외부 연동 인증 문서](../safari-extension.md), 정확한 승인 요청 형식은 [인증 라우트](../../backend/src/routes/extension-auth.ts)를 따른다.

extension 권한은 중국어 등록과 그룹 추가 등 허용된 경로로 제한된다. 이 문서의 두 smart-add, 그룹 조회·추가, `check-terms`, `POST /api/grammar/chinese/items/batch`는 현재 허용되어 있다. 문법 ID 확인은 batch 조회에 `{ "ids": ["기록한 ID"] }`를 보낼 수 있다. 일반 GET 단어/문법 조회나 수정·삭제 권한까지 있다고 가정하지 않는다. 다른 웹사이트의 브라우저에서 호출하려면 해당 origin의 CORS 허용 여부도 별도로 맞춰야 한다.

## 본등록과 초안의 구분

이 규약의 smart-add는 검토 대기 없이 DB에 본등록한다. 검토를 먼저 거치려면 [초안 JSON 규약](../draft-json-format.md)의 `/api/vocab/chinese/drafts` 또는 `/api/grammar/chinese/drafts`를 사용한다. 초안 업로드 HTTP 본문은 `{ "drafts": [...] }`이며, 파일 업로드용 `version`·`kind`·`language` envelope를 본등록 API에 그대로 보내지 않는다.

전용 외부 등록 API, 생성 요청의 완전한 멱등성 보장, 문법 항목+그룹의 원자적 등록은 이 규약만으로 추가되지 않는다. 단어 항목+그룹의 원자적 등록은 현재 지원한다. 이후 구현할 경우 이 문서와 JSON Schema를 함께 갱신한다.

## 구현 근거

- [단어 등록·중복 확인](../../backend/src/routes/vocab.ts)
- [문법 등록·설명 병합](../../backend/src/routes/grammar.ts)
- [공유 타입](../../backend/src/types.ts), [저장과 그룹 소속 처리](../../backend/src/firestore.ts)
- [외부 연동 권한 경로](../../backend/src/extension-routes.json), [토큰 처리](../../backend/src/extension-auth.ts)
