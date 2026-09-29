---
id: system.handover
title: エージェント引き継ぎ契約
description: 所有元を特定し、仕様を変更し、検証根拠と引き継ぎを残すための契約です。
category: Engineering
locale: ja
canonical: false
status: reader-translation
owner: Repository maintainers
reviewed: 2026-07-18
revision: 2026-07-18-ja
translation_of: system.handover
source_revision: 2026-07-18
source_of_truth: agentdeck-design-system/docs/handover.md
validators: [node scripts/build-design-system-viewer.mjs --check]
---

# エージェント引き継ぎ契約

視覚ルール、デバイス仕様、製品ポリシー、検証を変更するときに使用します。英語版が正本で、この文書は読者向け翻訳です。

## 最初に所有元を確認

| 変更                             | 最初に編集する正本                     | 続けて更新するもの                                |
| -------------------------------- | -------------------------------------- | ------------------------------------------------- |
| 色・文字・余白・角丸・モーション | `design/tokens.css` または `DESIGN.md` | トークンミラー、コンポーネント規則、Viewer の例   |
| 再利用コンポーネント             | `design/components.css` + `DESIGN.md`  | ランタイム実装と視覚 specimen                     |
| パネル・チップ・通信・対応状態   | `docs/hardware-compatibility.md`       | 運用ガイドと Devices の要約                       |
| App Store 機能・コピー境界       | `docs/appstore-feature-matrix.md`      | Review notes、メタデータ、archive verifier        |
| テスト上の主張                   | `docs/testing.md`                      | テスト実装、scenario mapping、Build Health の説明 |

## 変更手順

1. `AGENTS.md` と所有文書を読みます。
2. ミラーや表示より先に正本仕様を更新します。
3. 仕様を満たす最小のランタイム変更を実装します。
4. 指定された validator と、実際の動作で失敗できる検証を実行します。
5. 英語 revision の確定後に翻訳を更新します。
6. 所有関係の変更と検証根拠を `DEVELOPMENT_LOG.md` に残します。

ビルドラッパーは実機根拠ではなく、スクリーンショットはプロトコル根拠ではありません。引き継ぎには正本、ミラー・翻訳、影響範囲、検証結果、残る実機確認を明記します。
