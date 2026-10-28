# 線形代数JSON変換の検証記録（2026-10-28）

9章をMarkdown ASTの見出し位置から順序付きJSONへ変換した。
各章reportのmappingsは原文の全範囲をheading/bodyへ対応付け、装飾タグの位置を保存する。
その逆写像から元のMarkdownを再構成し、元SHA-256との完全一致を確認した。
inline/display mathのAST token列・個数も元と完全一致した。
原文の不均一な見出し深度とProperties、章共通仮定、URL、韓国語の補足も保持した。

`span/u/details/summary`タグは本文から除去したが内側の文言とMarkdown強調は保持する。
色・下線の位置と装飾HTMLは各reportのdecorationsで確認できる。アプリはraw HTMLを実行しない。
名称と判断できる先頭の括弧はitem.titleへ移し、元表記はheading逆写像に残した。
数式・仮定・数学的文言の校正は行っていない。

learningは全項目をrecognize/apply、proofCoverage:noneとする保守的な変換。
既定objectiveは難易度1–2で、prove・高難易度・証明教材の完全性を推論しない。
各項目のrequiresは空で、章の1→2→…→9の依存はsubject.jsonの8辺で明示した。
本文にあるProof sketchは本文として保存し、証明を採点する権限へ昇格しない。
完全一致は原文に含まれる数学的な誤りの不存在を保証しない。

再検証: `npm run test:math --prefix backend` のJSON conversionテストは
JSON＋reportから再構成し、各body断片と章全体のhashを検証する。
一度きりの変換adapter `backend/scripts/math-convert-notes.ts` は移行時の原MDが必要で、
通常deployや教材公開では実行しない。MD原本はGit履歴に残る。
