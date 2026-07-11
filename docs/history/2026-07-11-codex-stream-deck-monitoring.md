# Codex Stream Deck監視フェーズ完了メモ

## 目的

Codex CLIとCodex Desktopの実行状態を、AgentDeckのStream Deck Session Slotへ表示できるようにする。

## 完了状態

- `~/.codex/config.toml`の既存`[features]`を壊さず、AgentDeck管理のlifecycle hooksを導入できるようにした。
- 旧`~/.codex/hooks.json`内のAgentDeck hookとの二重実行を解消し、ユーザー所有hookは保持した。
- Node daemonの既存passive observerとlifecycle hook経路を使い、Codex CLIを表示できることを確認した。
- Node daemonのpassive observerがCodex Desktop本体のtop-level rolloutを`codex-app`として検出するようにした。内部subagentは表示しない。
- Desktopの`task_started`から`task_complete`までを`processing`、完了後を`idle`として表示する。
- ユーザー実機のStream DeckでCodex Desktop表示を確認済み。

## 主な変更箇所

- `hooks/src/codex-install.ts`, `hooks/src/codex-mini-toml.ts`
- `apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift`, `apple/AgentDeck/Daemon/Core/MiniToml.swift`
- `bridge/src/passive-observer.ts`
- 対応するNode/Swiftテスト、`docs/appstore-feature-matrix.md`

## 検証

- `pnpm build`成功。
- `pnpm test`成功: 94 files / 1701 tests（最新`origin/master`へrebase後に再検証）。
- Swift変更4ファイルは`swiftc -frontend -parse`成功。
- Node daemon再起動後、Codex CLIとCodex Desktopの配信を実機確認。
- Codex Desktopの`AgentDeck`タスクが`codex-app / processing / observed`として配信され、ユーザー側Stream Deckにも表示された。

## 未実施・申し送り

- ローカル環境がCommandLineToolsのみのため、完全版Xcodeによる`xcodebuild test`は未実施。
- リリースタグ作成とApp Store/npm配布は本フェーズの対象外。
