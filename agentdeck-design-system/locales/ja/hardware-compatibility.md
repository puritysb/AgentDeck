---
id: hardware.compatibility
title: ハードウェア・OS 互換性
description: デバイス、パネル、通信、ホスト、App Store 互換性の正本翻訳です。
category: Specs
locale: ja
canonical: false
status: reader-translation
owner: Hardware maintainers
reviewed: 2026-08-05
revision: 2026-08-05-ja
translation_of: hardware.compatibility
source_revision: 2026-08-05
source_of_truth: docs/hardware-compatibility.md
validators: [node scripts/build-design-system-viewer.mjs --check]
---

# ハードウェア・OS 互換性

AgentDeck の dashboard surface を一覧する読者向け翻訳です。英語の `docs/hardware-compatibility.md` が正本で、この文書だけの事実は追加しません。

## 対応表記

| 表記 | 意味                                         |
| :--: | -------------------------------------------- |
| 対応 | App Store Swift daemon またはアプリで対応    |
| 一部 | 明記した制限、または実機検証待ち             |
| CLI  | 外部 Node daemon または CLI 管理の通信が必要 |
| 実験 | 登録または firmware を開発中                 |

## Surface 一覧

| Surface             | 種類           | Platform / controller | Display                        | Transport               | App Store |
| ------------------- | -------------- | --------------------- | ------------------------------ | ----------------------- | :-------: |
| IPS 3.5             | ESP32 display  | ESP32-S3              | AXS15231B IPS · 480×320        | USB serial · Wi-Fi WS   |   対応    |
| Round AMOLED 1.8    | ESP32 display  | ESP32-S3              | ST77916 · 360×360              | USB serial · Wi-Fi WS   |   対応    |
| 86 Box 4.0          | ESP32 display  | ESP32-S3              | ST7701 IPS · 480×480           | USB serial · Wi-Fi WS   |   対応    |
| TTGO T-Display 1.14 | ESP32 display  | ESP32 classic         | ST7789 · 135×240               | USB serial · Wi-Fi WS   |   対応    |
| Waveshare LCD 1.47  | ESP32 display  | ESP32-C6              | ST7789 · 172×320               | USB serial · Wi-Fi WS   |   対応    |
| IPS 10.1            | ESP32 display  | ESP32-P4 + C6         | JD9365 MIPI-DSI · 800×1280     | USB serial · Wi-Fi WS   |   対応    |
| T-Embed Companion Knob | ESP32 knob  | ESP32-S3              | ST7789 · 320×170 + 8-LED ring  | Wi-Fi WS · USB serial   |   対応    |
| T-Display-S3-Pro Focus Strip | ESP32 strip | ESP32-S3        | ST7796U · 480×222 + touch      | Wi-Fi WS · USB serial   |   対応    |
| Ulanzi TC001        | ESP32 LED      | ESP32 classic         | WS2812B · 32×8                 | USB serial · Wi-Fi WS   |   一部    |
| InkDeck             | ESP32 e-ink    | XIAO ESP32-S3 Plus    | UC8179 · 800×480               | USB serial · Wi-Fi WS   |   対応    |
| XTeink X3           | e-ink reader   | ESP32-C3              | 3.7-inch · 528×792             | Wi-Fi WS                |   一部    |
| XTeink X4           | e-ink reader   | ESP32-C3              | 800×480                        | Wi-Fi WS                |   一部    |
| Divoom Pixoo64      | Commercial LED | Divoom controller     | RGB LED · 64×64                | HTTP REST               |   対応    |
| iDotMatrix          | Pixel display  | BLE SoC               | RGB · 32×32                    | BLE GATT                |   対応    |
| Divoom Timebox Mini | Commercial LED | BLE SoC               | RGB LED · 11×11                | BLE GATT                |   対応    |
| Ulanzi D200H        | HID deck       | SigmaStar SSD210      | LCD keys · logical 960×540     | Ulanzi Studio plugin    |   対応    |
| Stream Deck         | HID deck       | Elgato                | 15 LCD keys · 5×3              | Elgato plugin → WS      |   対応    |
| Stream Deck Mini    | HID deck       | Elgato                | 6 LCD keys · 3×2               | Elgato plugin → WS      |   対応    |
| Stream Deck+        | HID deck       | Elgato                | 8 keys · 4 dials · touch strip | Elgato plugin → WS      |   対応    |
| Stream Deck XL      | HID deck       | Elgato                | 32 LCD keys · 8×4              | Elgato plugin → WS      |   対応    |
| Stream Deck + XL    | HID deck       | Elgato                | 36 keys · 9×4 · 6 dials        | Elgato plugin → WS      |   対応    |
| macOS               | App            | Apple Silicon · Intel | Host display                   | In-process Swift daemon |   対応    |
| iOS / iPadOS        | App            | A-series · M-series   | Device display                 | Wi-Fi WS                |   対応    |
| Android e-ink       | App            | Vendor-specific       | B&W / color e-ink              | ADB localhost · mDNS    |   一部    |
| Android tablet      | App            | ARM · x86             | Color LCD                      | mDNS · Wi-Fi WS         |   一部    |
| TUI dashboard       | Terminal       | Host CPU              | truecolor terminal             | WS                      |   対応    |
| SSE stream          | Protocol       | Host                  | Browser / script               | HTTP `/sse`             |   一部    |

## 主な制約

- **集計サーフェス数: 26。** 公開サーフェス数(README、ランディング)はこの算定をミラーします — プロトコル行(SSE stream)を除く全行を数えます。XTeink X3/X4は正常稼働中(両daemonにWi-Fi登録)ですが、コミュニティのCrossPointフォークで駆動され、一部表記はその配布上の制約を示します。
- App Store 列は第三者アプリの同梱ではなく、提出する Apple アプリと Swift daemon との互換性を示します。
- D200H は Ulanzi Studio plugin のみ対応し、direct-HID は廃止済みです。
- Stream Deck family には Elgato アプリが必要です。
- TC001 の「一部」は sandbox 制約ではなく、Swift `led8x32` の実機検証待ちです。
- Android の same-LAN mDNS は利用できますが、`adb reverse` は CLI が必要です。
- SSE の full streaming と heartbeat は Node bridge のみで、Swift daemon は最初の `connected` event のみ送信します。
- ESP32 は USB port 名で推測せず、`device_info_request` で識別します。
- 同じ理由で、board 文字列だけで画面レイアウトを断定しません — T-Display-S3-Pro は起動時のカメラ有無で縦(Pocket)/横(Ticker) UI が分かれますが、両ユニットとも `t_display_pro` を報告し同じ OTA イメージを使います。

flash・OTA・pin の運用は `docs/esp32.md`、通信契約は `docs/devices.md`、App Store tier は `docs/appstore-feature-matrix.md` が所有します。
