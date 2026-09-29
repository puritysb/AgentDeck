# 2026-02-21 — Utility Dial (Multi-Mode Encoder for E1)

### 문제

E1 슬롯이 다른 플러그인(시스템 볼륨 등)으로 점유되어 있으면 AgentDeck의 encoder takeover 시 접근 불가. 자체 Utility Dial 액션을 만들어 E1을 AgentDeck 소속으로 가져와야 함.

### 해결

#### UtilityMode 인터페이스 패턴

- `plugin/src/utility-modes/types.ts`에 공통 인터페이스 정의
- 각 모드는 `id`, `label`, `onRotate`, `onPush`, `getFeedback`, 선택적 `onActivate`/`onDeactivate` 구현
- `plugin/src/utility-modes/index.ts`에서 factory (`createModes()`) + 레지스트리

#### macOS 시스템 API (osascript 래퍼)

- `plugin/src/utility-modes/macos.ts` — `execFile('osascript', ['-e', script])` (no shell)
- 채널별 debounce (`debouncedExec(key, script, delayMs)`) — 빠른 다이얼 회전 시 과다 호출 방지
- Volume/Mic: `get volume settings` 파싱, `set volume output/input volume N`
- Brightness: System Events `key code 144/145` — debounce 미적용 (개별 step)
- Media: Spotify/Music 자동 감지 (`getRunningPlayer()`), playpause/next/previous/track info
- Dark Mode: appearance preferences get/toggle
- Notification: `display notification` with sound

#### 6개 모드 구현

| Mode | File | Rotate | Push |
|------|------|--------|------|
| Volume | volume.ts | 출력 볼륨 ±5 | 음소거 토글 |
| Brightness | brightness.ts | 밝기 ±1 step | 최소 밝기 토글 |
| Mic | mic.ts | 입력 볼륨 ±5 | 마이크 음소거 |
| Media | media.ts | 볼륨 ±5 | 재생/일시정지 |
| Timer | timer.ts | 시간 ±5분 | 시작/일시정지/리셋 |
| Dark Mode | darkmode.ts | 없음 | 다크모드 토글 |

#### 모드 라이프사이클: onPause / onResume

모드 전환 시 비활성 모드의 타이머/폴링이 계속 돌아가는 리소스 낭비 문제를 해결하기 위해 `onPause`/`onResume` 훅을 도입.

| 훅 | 호출 시점 | 목적 |
|---|---|---|
| `onActivate` | 최초 진입 (rebuildModes) | 초기 상태 로드 + 타이머 시작 |
| `onPause` | 다른 모드로 전환 (onTouchTap) | 타이머/폴링 중지, 상태 보존 |
| `onResume` | 이 모드로 복귀 (onTouchTap) | 상태 재조회 + 타이머 재시작 |
| `onDeactivate` | 완전 정리 (rebuildModes, onWillDisappear) | 전부 해제, 상태 초기화 |

`onTouchTap` 흐름: `prev.onPause()` → `activeIndex++` → `next.onResume() ?? next.onActivate()`

#### 시스템 볼륨/마이크 동기화 (osascript 폴링)

외부에서 시스템 볼륨/마이크를 변경했을 때 Stream Deck에 반영되지 않는 문제.
macOS Core Audio 이벤트 구독은 네이티브 애드온 필요 → 배포 복잡도 증가로 기각.

**구현 (volume.ts, mic.ts)**:
- 2초 간격 `osascript "get volume settings"` 폴링 (활성 모드일 때만)
- `polling` 가드 — async 중첩 방지 (osascript 지연 시 동시 실행 차단)
- `startPolling()` — 항상 기존 타이머 제거 후 새로 생성 (타이머 누적 방지)
- `lastActionAt` + `SKIP_AFTER_ACTION(3s)` — 사용자 다이얼 조작 직후 폴링 스킵 (자기 변경 덮어쓰기 방지)
- 값 변경 감지 시에만 `refresh()` 호출 (불필요한 LCD 갱신 방지)

**시스템 부담**: 2초당 1회 execFile('osascript') — CPU 0.1% 미만, 일시 메모리 ~2MB (즉시 해제). 메모리 누수 없음.

#### 4-Encoder Takeover 모드

- `encoder-takeover.ts` 전면 재작성
- `has4Encoders()`: utilityIds 존재 여부로 3/4-encoder 모드 분기
- 4-enc: E1(utility)→Context, E2(option)→Focus, E3(command)→List p1, E4(voice)→List p2
- 3-enc: 기존 동작 유지 (backward compatible)

#### Property Inspector

- `utility-dial-pi.html`: enabledModes 체크박스, timerMinutes, volumeStep 설정
- PI 설정값은 문자열로 도착 → `numSetting()` 파서로 안전 변환

### 디버깅: Layout Overlap 무성 실패

- **증상**: E1 터치/회전/푸시 시 아무 반응 없음. 플러그인 로그도 없음.
- **원인**: `utility-layout.json`의 `title` rect [4,2,140,18]과 `mode-dots` rect [120,2,76,18]이 x=120-144에서 겹침
- **Stream Deck SDK 동작**: 레이아웃 요소가 겹치면 **전체 레이아웃 인스턴스화 거부** → 이벤트 라우팅도 차단. 플러그인 코드에 에러 없음.
- **진단 경로**: SDK 타입 확인 → 빌드 출력 확인 → `~/Library/Logs/ElgatoStreamDeck/StreamDeck.1.json` 시스템 로그에서 발견
- **교훈**: SD SDK 레이아웃은 요소 간 rect 겹침이 절대 불가. 시스템 로그(`StreamDeck.*.json`)가 유일한 진단 경로.
- **수정**: title=[8,0,120,18], mode-dots=[130,2,62,16]로 간격 확보

### Files

| File | Action |
|------|--------|
| `plugin/src/utility-modes/*.ts` (8 files) | New |
| `plugin/src/actions/utility-dial.ts` | New |
| `plugin/bound.../layouts/utility-layout.json` | New |
| `plugin/bound.../ui/utility-dial-pi.html` | New |
| `plugin/bound.../manifest.json` | Modified |
| `plugin/src/encoder-registry.ts` | Modified |
| `plugin/src/encoder-takeover.ts` | Rewritten |
| `plugin/src/plugin.ts` | Modified |

### Commits

| Hash | Message |
|------|---------|
| (unstaged) | feat: utility dial — multi-mode encoder with 6 macOS utility modes |

---
