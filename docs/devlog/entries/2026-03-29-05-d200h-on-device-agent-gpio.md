# 2026-03-29 — D200H on-device agent: GPIO 버튼 + 디스플레이 렌더링 해결

### 문제
ULANZI D200H (SSD210)에 커스텀 대시보드를 렌더링하고 14키 물리 버튼을 읽어야 함.

### 해결 (버튼 — 완료)
- 초기 가설: GPIO 매트릭스 → HID gadget으로 전환 → 다시 GPIO로 복귀
- `/dev/hidg1`에서 HID report를 읽을 수 있었으나, 이는 zkgui가 호스트PC로 보내려고 **write한** 데이터였음 (MCU→SSD210 방향 아님)
- zkgui 죽인 후 `/dev/hidg1` 데이터 없음 → GPIO가 실제 버튼 입력 경로 확인
- sysfs GPIO 스캔으로 `OUT=6→IN=1`, `OUT=9→IN=1` 감지. 출력 {4,5,6,9,85}, 입력 {0,1,84}

### 해결 (디스플레이 — 완료)
- fbdev (`/dev/fb0`) mmap/write: 모든 ioctl 성공하지만 화면 변화 없음
- MI_DISP API (dlopen): `GetBuf`/`PutBuf` ret=0 성공하지만 화면 변화 없음
- `/proc/{zkgui_pid}/maps` 확인 결과, zkgui는 `/dev/fb0`를 `offset=0x50101000`으로 매핑하고 MI_GFX를 사용
- **핵심 발견**: visible target은 fbdev가 보고하는 `smem_start=0x30101000`이 아니라, GFX에서 접근하는 bus alias `0x50101000`의 **page0**
- `MI_GFX_Open()`은 처음엔 실패했으나, 원인은 `libmi_gfx.so`가 `_MI_PRINT_GetDebugLevel`을 `libmi_sys.so`에서 동적 해석해야 하는데 `dlopen(..., RTLD_GLOBAL)`이 빠졌던 것
- `MI_GFX_QuickFill()`로 `0x50101000` page0를 직접 칠하면 AgentDeck 화면이 실제 LCD에 표시됨
- `framebuffer.c`를 수정해 소프트웨어 백버퍼를 `/dev/fb0` page1에 쓴 뒤 `MI_GFX_BitBlit()`으로 visible page0에 복사하는 MI backend로 교체
- 초기 검은 화면 원인은 MI backend init 직후 비어 있는 page1을 page0로 복사한 버그였고, 초기 bitblit 제거로 해결
- 최종적으로 `/tmp/agentdeck --stdin` 실행 시 D200H에서 AgentDeck UI 표시 확인

### 핵심 설계 결정
- 버튼: sysfs GPIO 매트릭스 스캔 (`buttons.c`), 20ms 주기, open/close 방식 (lseek 불안정)
- 통신: Bridge `dispatchCommand()` + D200H agent stdout JSON 파싱 (stdin 모드)
- zkgui bind mount 무력화: `mount -o bind /dev/null /bin/zkgui` (init 재시작 차단)
- MI SDK 구조체: steward-fu/nds + loop0728/zkgui_sample에서 확인 (`E_MI_MODULE_ID_DISP=15`)
- MI_GFX 로더: `libmi_sys.so`, `libmi_gfx.so`는 `RTLD_GLOBAL`로 열어야 `_MI_PRINT_GetDebugLevel` 해석 가능
- D200H 렌더 target: `0x50101000` bus alias의 page0 (visible), page1은 staging source로 사용 가능
- agent 렌더 구조: draw는 기존 소프트웨어 경로 유지, `fb_present()`만 MI_GFX bitblit backend로 교체
- 디스플레이 조사 문서: `zkswe/DISPLAY_RESEARCH.md`, 이어서 작업 프롬프트: `zkswe/PROMPT.md`

---
