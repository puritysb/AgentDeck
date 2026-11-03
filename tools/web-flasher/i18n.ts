/**
 * en / ko / ja for the flasher, sharing the site-wide `agentdeck-design-locale`
 * key so a language chosen on any Pages surface carries over.
 *
 * EVERY ERROR STRING IS AN ENTRY. On a page whose whole job is a risky USB
 * operation, error copy is the part users actually read — a translated heading
 * over an English "NetworkError: Failed to open serial port" helps nobody. The
 * only untranslated text is what the hardware itself says (chip descriptions,
 * raw esptool log lines), which is quoted, not authored.
 */

export type Locale = "en" | "ko" | "ja";
export const LOCALES: Locale[] = ["en", "ko", "ja"];
export const LOCALE_KEY = "agentdeck-design-locale";

type Dict = Record<string, string>;

/** English is the canonical set; ko/ja are overlays and may not add keys. */
const EN = {
  "head.kicker": "AgentDeck",
  "head.h1": "Flash ESP32 firmware",
  "head.lede":
    "Connect a board over USB and install AgentDeck firmware from this page. No checkout, no PlatformIO, no toolchain.",
  "head.fw": "Firmware",
  "fw.loading": "loading…",
  "fw.none": "no firmware deployed",

  "unsupported.h": "This browser cannot flash",
  "unsupported.use":
    "Use <strong>Chrome</strong> or <strong>Edge</strong> on a desktop computer, or flash from the terminal:",
  "unsupported.copy": "Copy command",
  "unsupported.docs": "USB flashing guide",
  "why.insecure":
    "This page is not running in a secure context. Web Serial needs HTTPS (or localhost).",
  "why.firefox": "Firefox does not implement the Web Serial API, and has stated it will not.",
  "why.safari": "Safari does not implement the Web Serial API.",
  "why.mobile":
    "Mobile browsers do not implement the Web Serial API — Chrome on Android included.",
  "why.other": "This browser does not implement the Web Serial API.",

  "s1.h": "1 · Free the serial port",
  "s1.p":
    "A running AgentDeck daemon holds the board's serial port, and every open resets the board. This is the most common cause of a failed flash — and this page <strong>cannot detect it</strong>, because an HTTPS page is not allowed to probe your local daemon.",
  "s1.check": "I ran <code class=\"mono\">agentdeck daemon stop</code> and quit the AgentDeck app",
  "s1.hint": "Verify with <code class=\"mono\">lsof /dev/cu.*</code> — it should print nothing.",

  "s2.h": "2 · Pick your board",
  "s2.label": "Board",
  "s2.unavailable": "This board is not offered here yet.",
  "s2.nofirmware": "No firmware is deployed on this page, so no board can be flashed here yet.",
  "s2.alt":
    "Flash it with <code class=\"mono\">agentdeck esp32 flash</code>, or build it from source with PlatformIO.",

  "s3.h": "3 · Connect and identify",
  "s3.read": "This step only <strong>reads</strong> from the board. Nothing is written yet.",
  "s3.btn": "Connect & identify",
  "s3.picking": "Select a port…",
  "s3.working": "Talking to the board…",
  "s3.hint.native":
    "Native-USB board: if it will not connect, hold BOOT, tap RST (or replug), release BOOT — then pick the port that appears. Entering download mode gives the board a <strong>different</strong> port name from the one it runs on.",
  "s3.hint.uart": "USB-serial bridge board: it enters the bootloader on its own.",

  "s4.h": "4 · Install",
  "s4.btn": "Install firmware",
  "s4.erase": "erase the whole flash first (slower; clears saved Wi-Fi and pairing token)",
  "s4.erase-unavailable":
    "This board is flashed through its ROM loader, which has no erase command — erasing is unavailable here. The firmware still installs; saved Wi-Fi and the pairing token are kept.",
  "s4.confirm": "Do not unplug the board until this finishes.",
  "s4.detected": "Detected",
  "s4.expected": "Expected",
  "s4.chip": "Chip",
  "s4.flash": "Flash",
  "s4.mac": "MAC",

  "v.ok": "Ready to flash. The chip and flash size both match this board's image.",
  "v.ok-unknown-flash":
    "Ready to flash. The chip matches. This board will not report its flash size over the ROM loader, so only the chip family could be checked — the image's flash geometry was fixed at build time and verified in CI.",
  "v.chip-mismatch":
    "Refusing to write: this is not the board you selected. Writing this image would very likely brick it.",
  "v.flash-too-small":
    "Refusing to write: the image declares more flash than this part reports. That combination leaves an unbootable header.",
  "v.board-not-offered": "This board is not offered for browser flashing.",
  "v.image-geometry-mismatch":
    "Refusing to write: the deployed firmware was built for different flash geometry than this page expects for the board. Flash it from the terminal with a matching release instead.",
  "v.noforce":
    "There is no override. Pick the board you actually have, or flash it from the terminal.",

  "p.download": "Downloading firmware",
  "p.verify-download": "Checking the download against the release manifest",
  "p.connect": "Connecting",
  "p.identify": "Identifying the chip",
  "p.erase": "Erasing flash",
  "p.write": "Writing",
  "p.verify": "Verifying (MD5)",
  "p.done": "Done",

  "done.h": "Firmware installed",
  "done.p":
    "The board was written and its MD5 matched. Unplug it and plug it back in, then start the daemon again.",
  "done.next": "Check it appeared:",
  "done.tc001":
    "This board's serial TX is broken in hardware, so it will never answer a serial probe. Confirm the flash by what the matrix shows and by the board joining Wi-Fi — never by a serial check.",
  "done.wifi":
    "To put Wi-Fi credentials on it, plug it in with the daemon running and use <code class=\"mono\">agentdeck wifi-setup</code>.",

  "err.h": "That did not work",
  "err.page-holds-port":
    "This page is still holding the serial port from a previous attempt. Reload the page and try again.",
  "err.port-busy":
    "The serial port is held by another program. That is almost always the AgentDeck daemon or the macOS app — stop both, then try again.",
  "err.no-port": "No port was selected.",
  "err.connect":
    "The board never answered. Put it in download mode (hold BOOT, tap RST, release BOOT) and pick the port that appears afterwards.",
  "err.manifest":
    "No firmware is deployed on this page yet. Flash from the terminal instead, or grab the release assets.",
  "err.download": "The firmware download failed or did not match its published hash. Reload and try again.",
  "err.erase-unavailable":
    "Erasing is not available on this board. Untick it and install again — the firmware still installs.",
  "err.md5":
    "The board's flash does not match what was sent. Nothing was verified — flash again before using the board.",
  "err.retry": "Try again",
  "err.raw": "Raw log",

  "foot.built": "Firmware images are downloaded from this site, not from a third party.",
  "foot.third": "Third-party licences",
} satisfies Dict;

export type MessageKey = keyof typeof EN;

const KO: Partial<Record<MessageKey, string>> = {
  // A brand name, but present so the dictionaries are complete sets: the only
  // gate over these is that every key EN defines has a peer here.
  "head.kicker": "AgentDeck",
  "head.h1": "ESP32 펌웨어 설치",
  "head.lede":
    "보드를 USB로 연결하면 이 페이지에서 바로 AgentDeck 펌웨어를 설치합니다. 체크아웃도, PlatformIO도, 툴체인도 필요 없습니다.",
  "head.fw": "펌웨어",
  "fw.loading": "불러오는 중…",
  "fw.none": "배포된 펌웨어 없음",

  "unsupported.h": "이 브라우저로는 플래시할 수 없습니다",
  "unsupported.use":
    "데스크톱 <strong>Chrome</strong> 또는 <strong>Edge</strong>를 쓰거나, 터미널에서 설치하세요:",
  "unsupported.copy": "명령 복사",
  "unsupported.docs": "USB 플래싱 가이드",
  "why.insecure": "이 페이지가 보안 컨텍스트가 아닙니다. Web Serial은 HTTPS(또는 localhost)를 요구합니다.",
  "why.firefox": "Firefox는 Web Serial API를 구현하지 않으며, 구현하지 않겠다고 밝혔습니다.",
  "why.safari": "Safari는 Web Serial API를 구현하지 않습니다.",
  "why.mobile": "모바일 브라우저는 Web Serial API를 구현하지 않습니다 — Android용 Chrome도 마찬가지입니다.",
  "why.other": "이 브라우저는 Web Serial API를 구현하지 않습니다.",

  "s1.h": "1 · 시리얼 포트 비우기",
  "s1.p":
    "AgentDeck 데몬이 실행 중이면 보드의 시리얼 포트를 잡고 있고, 포트를 열 때마다 보드가 리셋됩니다. 플래시 실패의 가장 흔한 원인이며, 이 페이지는 그것을 <strong>감지할 수 없습니다</strong> — HTTPS 페이지는 로컬 데몬을 탐색할 수 없기 때문입니다.",
  "s1.check": "<code class=\"mono\">agentdeck daemon stop</code>을 실행하고 AgentDeck 앱을 종료했습니다",
  "s1.hint": "<code class=\"mono\">lsof /dev/cu.*</code>로 확인하세요 — 아무것도 나오지 않아야 합니다.",

  "s2.h": "2 · 보드 선택",
  "s2.label": "보드",
  "s2.unavailable": "이 보드는 아직 여기서 제공하지 않습니다.",
  "s2.nofirmware": "이 페이지에 배포된 펌웨어가 없어서 아직 어떤 보드도 설치할 수 없습니다.",
  "s2.alt":
    "<code class=\"mono\">agentdeck esp32 flash</code>로 설치하거나, PlatformIO로 소스에서 빌드하세요.",

  "s3.h": "3 · 연결하고 확인",
  "s3.read": "이 단계는 보드를 <strong>읽기만</strong> 합니다. 아직 아무것도 쓰지 않습니다.",
  "s3.btn": "연결 & 확인",
  "s3.picking": "포트를 선택하세요…",
  "s3.working": "보드와 통신 중…",
  "s3.hint.native":
    "네이티브 USB 보드: 연결되지 않으면 BOOT를 누른 채 RST를 짧게 누르고(또는 다시 꽂고) BOOT를 놓은 뒤, 새로 나타난 포트를 고르세요. 다운로드 모드로 들어가면 평소 동작할 때와 <strong>다른</strong> 포트 이름으로 잡힙니다.",
  "s3.hint.uart": "USB-시리얼 브리지 보드: 스스로 부트로더로 진입합니다.",

  "s4.h": "4 · 설치",
  "s4.btn": "펌웨어 설치",
  "s4.erase": "먼저 플래시 전체 지우기 (느림; 저장된 WiFi와 페어링 토큰이 사라집니다)",
  "s4.erase-unavailable":
    "이 보드는 ROM 로더로 플래시되는데 거기엔 지우기 명령이 없어서, 여기서는 지우기를 쓸 수 없습니다. 펌웨어는 정상 설치되며 저장된 WiFi와 페어링 토큰은 남습니다.",
  "s4.confirm": "끝날 때까지 보드를 뽑지 마세요.",
  "s4.detected": "검출",
  "s4.expected": "기대",
  "s4.chip": "칩",
  "s4.flash": "플래시",
  "s4.mac": "MAC",

  "v.ok": "설치할 수 있습니다. 칩과 플래시 크기가 이 보드의 이미지와 일치합니다.",
  "v.ok-unknown-flash":
    "설치할 수 있습니다. 칩은 일치합니다. 이 보드는 ROM 로더로는 플래시 크기를 알려주지 않아 칩 패밀리만 확인했습니다 — 이미지의 플래시 지오메트리는 빌드 시점에 고정되고 CI에서 검증됩니다.",
  "v.chip-mismatch": "쓰기를 거부합니다: 선택한 보드가 아닙니다. 이 이미지를 쓰면 벽돌이 될 가능성이 큽니다.",
  "v.flash-too-small":
    "쓰기를 거부합니다: 이미지가 선언한 플래시 크기가 이 부품이 보고한 크기보다 큽니다. 이 조합은 부팅 불가능한 헤더를 남깁니다.",
  "v.board-not-offered": "이 보드는 브라우저 플래싱을 제공하지 않습니다.",
  "v.image-geometry-mismatch":
    "쓰기를 거부합니다: 배포된 펌웨어가 이 페이지가 이 보드에 대해 기대하는 플래시 지오메트리와 다르게 빌드됐습니다. 맞는 릴리스로 터미널에서 설치하세요.",
  "v.noforce": "우회 수단은 없습니다. 실제로 가진 보드를 고르거나, 터미널에서 설치하세요.",

  "p.download": "펌웨어 내려받는 중",
  "p.verify-download": "내려받은 파일을 릴리스 매니페스트와 대조 중",
  "p.connect": "연결 중",
  "p.identify": "칩 확인 중",
  "p.erase": "플래시 지우는 중",
  "p.write": "쓰는 중",
  "p.verify": "검증 중 (MD5)",
  "p.done": "완료",

  "done.h": "펌웨어 설치 완료",
  "done.p": "보드에 썼고 MD5가 일치했습니다. 케이블을 뽑았다 다시 꽂은 뒤 데몬을 다시 시작하세요.",
  "done.next": "잡혔는지 확인:",
  "done.tc001":
    "이 보드는 시리얼 TX가 하드웨어적으로 고장 나 있어 시리얼 프로브에 절대 답하지 않습니다. 매트릭스 화면과 WiFi 합류로 확인하고, 시리얼 확인은 쓰지 마세요.",
  "done.wifi":
    "WiFi 자격 증명은 데몬을 켠 채 케이블을 꽂고 <code class=\"mono\">agentdeck wifi-setup</code>으로 넣으세요.",

  "err.h": "실패했습니다",
  "err.page-holds-port":
    "이전 시도에서 이 페이지가 아직 시리얼 포트를 잡고 있습니다. 페이지를 새로고침한 뒤 다시 시도하세요.",
  "err.port-busy":
    "다른 프로그램이 시리얼 포트를 잡고 있습니다. 거의 항상 AgentDeck 데몬이나 macOS 앱입니다 — 둘 다 종료하고 다시 시도하세요.",
  "err.no-port": "포트를 선택하지 않았습니다.",
  "err.connect":
    "보드가 응답하지 않았습니다. 다운로드 모드로 넣고(BOOT 누른 채 RST, BOOT 놓기) 그 뒤에 나타난 포트를 고르세요.",
  "err.manifest":
    "이 페이지에 아직 배포된 펌웨어가 없습니다. 터미널에서 설치하거나 릴리스 에셋을 직접 받으세요.",
  "err.download": "펌웨어 내려받기에 실패했거나 게시된 해시와 일치하지 않습니다. 새로고침 후 다시 시도하세요.",
  "err.erase-unavailable":
    "이 보드에서는 지우기를 쓸 수 없습니다. 체크를 풀고 다시 설치하세요 — 펌웨어는 정상 설치됩니다.",
  "err.md5":
    "보드의 플래시가 보낸 내용과 다릅니다. 검증되지 않았으니 사용하기 전에 다시 설치하세요.",
  "err.retry": "다시 시도",
  "err.raw": "원본 로그",

  "foot.built": "펌웨어 이미지는 제3자가 아니라 이 사이트에서 내려받습니다.",
  "foot.third": "서드파티 라이선스",
};

const JA: Partial<Record<MessageKey, string>> = {
  "head.kicker": "AgentDeck",
  "head.h1": "ESP32ファームウェアを書き込む",
  "head.lede":
    "ボードをUSBで接続すれば、このページからAgentDeckファームウェアをインストールできます。チェックアウトもPlatformIOもツールチェーンも不要です。",
  "head.fw": "ファームウェア",
  "fw.loading": "読み込み中…",
  "fw.none": "デプロイ済みファームウェアなし",

  "unsupported.h": "このブラウザでは書き込めません",
  "unsupported.use":
    "デスクトップの<strong>Chrome</strong>または<strong>Edge</strong>を使うか、ターミナルから書き込んでください:",
  "unsupported.copy": "コマンドをコピー",
  "unsupported.docs": "USB書き込みガイド",
  "why.insecure": "このページはセキュアコンテキストではありません。Web SerialにはHTTPS（またはlocalhost）が必要です。",
  "why.firefox": "FirefoxはWeb Serial APIを実装しておらず、実装しない方針を表明しています。",
  "why.safari": "SafariはWeb Serial APIを実装していません。",
  "why.mobile": "モバイルブラウザはWeb Serial APIを実装していません — Android版Chromeも含みます。",
  "why.other": "このブラウザはWeb Serial APIを実装していません。",

  "s1.h": "1 · シリアルポートを空ける",
  "s1.p":
    "AgentDeck daemonが動いているとボードのシリアルポートを掴んでおり、ポートを開くたびにボードがリセットされます。書き込み失敗の最も多い原因ですが、このページからは<strong>検出できません</strong> — HTTPSページはローカルdaemonを探れないためです。",
  "s1.check": "<code class=\"mono\">agentdeck daemon stop</code>を実行し、AgentDeckアプリを終了しました",
  "s1.hint": "<code class=\"mono\">lsof /dev/cu.*</code>で確認してください — 何も表示されないはずです。",

  "s2.h": "2 · ボードを選ぶ",
  "s2.label": "ボード",
  "s2.unavailable": "このボードはまだここでは提供していません。",
  "s2.nofirmware": "このページにデプロイ済みファームウェアがないため、まだどのボードも書き込めません。",
  "s2.alt":
    "<code class=\"mono\">agentdeck esp32 flash</code>で書き込むか、PlatformIOでソースからビルドしてください。",

  "s3.h": "3 · 接続して確認",
  "s3.read": "この段階はボードを<strong>読むだけ</strong>です。まだ何も書きません。",
  "s3.btn": "接続して確認",
  "s3.picking": "ポートを選択してください…",
  "s3.working": "ボードと通信中…",
  "s3.hint.native":
    "ネイティブUSBボード: 接続できない場合はBOOTを押しながらRSTを短く押し（または挿し直し）、BOOTを離してから、新しく現れたポートを選んでください。ダウンロードモードでは通常動作時とは<strong>別の</strong>ポート名になります。",
  "s3.hint.uart": "USB-シリアルブリッジのボード: 自分でブートローダーに入ります。",

  "s4.h": "4 · インストール",
  "s4.btn": "ファームウェアをインストール",
  "s4.erase": "先にフラッシュ全体を消去する（低速; 保存済みWi-Fiとペアリングトークンが消えます）",
  "s4.erase-unavailable":
    "このボードはROMローダー経由で書き込むため消去コマンドがなく、ここでは消去できません。ファームウェアは通常どおりインストールされ、保存済みWi-Fiとペアリングトークンは残ります。",
  "s4.confirm": "完了するまでボードを抜かないでください。",
  "s4.detected": "検出",
  "s4.expected": "期待値",
  "s4.chip": "チップ",
  "s4.flash": "フラッシュ",
  "s4.mac": "MAC",

  "v.ok": "書き込めます。チップもフラッシュサイズもこのボードのイメージと一致しています。",
  "v.ok-unknown-flash":
    "書き込めます。チップは一致しています。このボードはROMローダー経由でフラッシュサイズを返さないため、チップファミリーのみ確認しました — イメージのフラッシュ形状はビルド時に固定され、CIで検証済みです。",
  "v.chip-mismatch": "書き込みを拒否します: 選択したボードではありません。このイメージを書くと文鎮化する可能性が高いです。",
  "v.flash-too-small":
    "書き込みを拒否します: イメージが宣言するフラッシュ容量が、この部品の報告値より大きいです。この組み合わせは起動不能なヘッダーを残します。",
  "v.board-not-offered": "このボードはブラウザ書き込みに対応していません。",
  "v.image-geometry-mismatch":
    "書き込みを拒否します: デプロイ済みファームウェアが、このページがこのボードに期待するフラッシュ形状とは異なる設定でビルドされています。対応するリリースでターミナルから書き込んでください。",
  "v.noforce": "回避手段はありません。実際に持っているボードを選ぶか、ターミナルから書き込んでください。",

  "p.download": "ファームウェアをダウンロード中",
  "p.verify-download": "ダウンロードをリリースマニフェストと照合中",
  "p.connect": "接続中",
  "p.identify": "チップを確認中",
  "p.erase": "フラッシュを消去中",
  "p.write": "書き込み中",
  "p.verify": "検証中 (MD5)",
  "p.done": "完了",

  "done.h": "ファームウェアをインストールしました",
  "done.p": "書き込みが完了し、MD5も一致しました。ケーブルを抜き差ししてから、daemonを再起動してください。",
  "done.next": "認識されたか確認:",
  "done.tc001":
    "このボードはシリアルTXがハードウェア的に壊れており、シリアルプローブには決して応答しません。マトリクス表示とWi-Fi参加で確認し、シリアル確認は使わないでください。",
  "done.wifi":
    "Wi-Fi認証情報は、daemonを起動した状態でケーブルを挿し<code class=\"mono\">agentdeck wifi-setup</code>で書き込んでください。",

  "err.h": "うまくいきませんでした",
  "err.page-holds-port":
    "前回の試行からこのページがまだシリアルポートを掴んでいます。ページを再読み込みして再試行してください。",
  "err.port-busy":
    "別のプログラムがシリアルポートを掴んでいます。ほぼ必ずAgentDeck daemonかmacOSアプリです — 両方を終了してから再試行してください。",
  "err.no-port": "ポートが選択されませんでした。",
  "err.connect":
    "ボードが応答しませんでした。ダウンロードモードに入れ（BOOTを押しながらRST、BOOTを離す）、その後に現れたポートを選んでください。",
  "err.manifest":
    "このページにはまだファームウェアがデプロイされていません。ターミナルから書き込むか、リリースアセットを直接取得してください。",
  "err.download": "ファームウェアのダウンロードに失敗したか、公開ハッシュと一致しませんでした。再読み込みして再試行してください。",
  "err.erase-unavailable":
    "このボードでは消去できません。チェックを外して再度インストールしてください — ファームウェアは通常どおり入ります。",
  "err.md5": "ボードのフラッシュが送信内容と一致しません。検証できていないので、使う前に書き込み直してください。",
  "err.retry": "再試行",
  "err.raw": "生ログ",

  "foot.built": "ファームウェアイメージは第三者ではなく、このサイトから配信されます。",
  "foot.third": "サードパーティライセンス",
};

const DICTS: Record<Locale, Partial<Record<MessageKey, string>>> = { en: EN, ko: KO, ja: JA };

let current: Locale = "en";

export function currentLocale(): Locale {
  return current;
}

export function setLocale(l: Locale): void {
  current = LOCALES.includes(l) ? l : "en";
  document.documentElement.lang = current;
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.getAttribute("data-i18n") as MessageKey | null;
    if (!key) continue;
    // Only repository-authored translations may contain markup. Unknown DOM
    // keys are displayed literally, including the fallback key itself.
    if (Object.hasOwn(EN, key)) node.innerHTML = t(key);
    else node.textContent = key;
  }
}

/** Look up a key; English is the fallback, and a missing key shows itself. */
export function t(key: MessageKey): string {
  if (!Object.hasOwn(EN, key)) return key;
  return DICTS[current][key] ?? EN[key];
}

export function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return LOCALES.includes(v as Locale) ? (v as Locale) : "en";
  } catch {
    return "en"; // private windows throw on access, not on read
  }
}

export function storeLocale(l: Locale): void {
  try { localStorage.setItem(LOCALE_KEY, l); } catch { /* nothing depends on it persisting */ }
}
