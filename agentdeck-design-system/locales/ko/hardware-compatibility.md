---
id: hardware.compatibility
title: 하드웨어 및 OS 호환성
description: 기기, 패널, 전송, 호스트, App Store 호환성의 정본 번역.
category: Specs
locale: ko
canonical: false
status: reader-translation
owner: Hardware maintainers
reviewed: 2026-08-05
revision: 2026-08-05-ko
translation_of: hardware.compatibility
source_revision: 2026-08-05
source_of_truth: docs/hardware-compatibility.md
validators: [node scripts/build-design-system-viewer.mjs --check]
---

# 하드웨어 및 OS 호환성

AgentDeck 대시보드 표면의 호환성을 한눈에 보기 위한 독자용 번역이다. 영어 `docs/hardware-compatibility.md`가 정본이며, 이 문서는 새 사실을 추가하지 않는다.

## 지원 표기

| 표기 | 의미                                     |
| :--: | ---------------------------------------- |
| 지원 | App Store Swift daemon 또는 앱에서 지원  |
| 일부 | 명시된 제한이 있거나 실기 검증 대기      |
| CLI  | 외부 Node daemon 또는 CLI 관리 전송 필요 |
| 실험 | 등록 또는 펌웨어 개발 중                 |

## 전체 표면

| 표면                | 종류                 | 플랫폼 / 컨트롤러     | 디스플레이                     | 전송                  | App Store |
| ------------------- | -------------------- | --------------------- | ------------------------------ | --------------------- | :-------: |
| IPS 3.5             | ESP32 디스플레이     | ESP32-S3              | AXS15231B IPS · 480×320        | USB serial · Wi-Fi WS |   지원    |
| 원형 AMOLED 1.8     | ESP32 디스플레이     | ESP32-S3              | ST77916 · 360×360              | USB serial · Wi-Fi WS |   지원    |
| 86 Box 4.0          | ESP32 디스플레이     | ESP32-S3              | ST7701 IPS · 480×480           | USB serial · Wi-Fi WS |   지원    |
| TTGO T-Display 1.14 | ESP32 디스플레이     | ESP32 classic         | ST7789 · 135×240               | USB serial · Wi-Fi WS |   지원    |
| Waveshare LCD 1.47  | ESP32 디스플레이     | ESP32-C6              | ST7789 · 172×320               | USB serial · Wi-Fi WS |   지원    |
| IPS 10.1            | ESP32 디스플레이     | ESP32-P4 + C6         | JD9365 MIPI-DSI · 800×1280     | USB serial · Wi-Fi WS |   지원    |
| T-Embed 컴패니언 노브 | ESP32 노브         | ESP32-S3              | ST7789 · 320×170 + 8-LED 링    | Wi-Fi WS · USB serial |   지원    |
| T-Display-S3-Pro 포커스 스트립 | ESP32 스트립 | ESP32-S3           | ST7796U · 480×222 + 터치       | Wi-Fi WS · USB serial |   지원    |
| Ulanzi TC001        | ESP32 LED            | ESP32 classic         | WS2812B · 32×8                 | USB serial · Wi-Fi WS |   일부    |
| InkDeck             | ESP32 e-ink          | XIAO ESP32-S3 Plus    | UC8179 · 800×480               | USB serial · Wi-Fi WS |   지원    |
| XTeink X3           | e-ink 리더           | ESP32-C3              | 3.7-inch · 528×792             | Wi-Fi WS              |   일부    |
| XTeink X4           | e-ink 리더           | ESP32-C3              | 800×480                        | Wi-Fi WS              |   일부    |
| Divoom Pixoo64      | 상용 LED             | Divoom controller     | RGB LED · 64×64                | HTTP REST             |   지원    |
| iDotMatrix          | 상용 픽셀 디스플레이 | BLE SoC               | RGB · 32×32                    | BLE GATT              |   지원    |
| Divoom Timebox Mini | 상용 LED             | BLE SoC               | RGB LED · 11×11                | BLE GATT              |   지원    |
| Ulanzi D200H        | HID deck             | SigmaStar SSD210      | LCD keys · 논리 960×540        | Ulanzi Studio plugin  |   지원    |
| Stream Deck         | HID deck             | Elgato                | 15 LCD keys · 5×3              | Elgato plugin → WS    |   지원    |
| Stream Deck Mini    | HID deck             | Elgato                | 6 LCD keys · 3×2               | Elgato plugin → WS    |   지원    |
| Stream Deck+        | HID deck             | Elgato                | 8 keys · 4 dials · touch strip | Elgato plugin → WS    |   지원    |
| Stream Deck XL      | HID deck             | Elgato                | 32 LCD keys · 8×4              | Elgato plugin → WS    |   지원    |
| Stream Deck + XL    | HID deck             | Elgato                | 36 keys · 9×4 · 6 dials        | Elgato plugin → WS    |   지원    |
| macOS               | 앱                   | Apple Silicon · Intel | 호스트 디스플레이              | 내장 Swift daemon     |   지원    |
| iOS / iPadOS        | 앱                   | A-series · M-series   | 기기 디스플레이                | Wi-Fi WS              |   지원    |
| Android e-ink       | 앱                   | 벤더별                | B&W 또는 컬러 e-ink            | ADB localhost · mDNS  |   일부    |
| Android 태블릿      | 앱                   | ARM · x86             | 컬러 LCD                       | mDNS · Wi-Fi WS       |   일부    |
| TUI dashboard       | 터미널               | 호스트 CPU            | truecolor terminal             | WS                    |   지원    |
| SSE stream          | 프로토콜             | 호스트                | 브라우저 또는 스크립트         | HTTP `/sse`           |   일부    |

## 핵심 제약

- **집계 표면 수: 26.** 공개 표면 수(README, 랜딩)는 이 산정을 미러링한다 — 프로토콜 행(SSE stream)을 제외한 모든 행이 집계된다. XTeink X3/X4는 정상 운영되나(양쪽 데몬에 Wi-Fi 등록) 커뮤니티 CrossPoint 포크로 구동되며, 일부 표기는 그 배포 제약을 뜻한다.
- App Store 열은 제3자 호스트 앱의 번들 포함 여부가 아니라 제출된 Apple 앱과 Swift daemon의 호환성을 뜻한다.
- D200H는 Ulanzi Studio plugin만 지원하고 direct-HID 경로는 폐기됐다.
- Stream Deck 계열은 Elgato 앱이 필요하다.
- TC001의 일부 표기는 sandbox 제약이 아니라 Swift `led8x32` 실기 검증 대기 상태다.
- Android의 같은 LAN mDNS 연결은 가능하지만 `adb reverse`는 CLI가 필요하다.
- SSE 전체 streaming과 heartbeat는 Node bridge에만 있으며 Swift daemon은 최초 `connected` 이벤트만 보낸다.
- USB 포트 이름으로 ESP32 보드를 추정하지 말고 `device_info_request`로 식별한다.
- 같은 이유로 board 문자열만으로 화면 배치를 단정하지 않는다 — T-Display-S3-Pro는 부팅 시 카메라 유무로 세로(Pocket)/가로(Ticker) UI가 갈리지만 두 유닛 모두 `t_display_pro`를 보고하고 같은 OTA 이미지를 쓴다.

보드별 flash·OTA·핀과 운영 절차는 `docs/esp32.md`, 전송 규약은 `docs/devices.md`, App Store tier는 `docs/appstore-feature-matrix.md`가 소유한다.
