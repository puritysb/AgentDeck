# 2026-07-27 — Knob 크리처 캐러셀 + Focus Strip 물리 입력/터치 재설계

T-Embed list를 텍스트 카드에서 정본 A8 크리처 glyph 중심의 휠 캐러셀로
바꿨다. 선택 크리처는 상태색 halo 안에서 중앙을 차지하고 이전/다음
크리처는 양옆에 낮은 opacity로 보여 encoder detent와 시각 변화가 바로
연결된다. glyph는 flash-backed 정적 descriptor라 프레임 버퍼나 지속
할당을 추가하지 않는다.

T-Display-S3-Pro의 네 물리 버튼을 다시 확인했다. 앱이 읽는 입력은
BOOT(GPIO0)와 분할 rocker(GPIO12/16) 세 개이고, 네 번째 RST는 하드웨어
reset이다. rocker는 이전/다음, BOOT는 Focus/선택, RST는 복구로 역할을
고정했다. auto-cycle을 제거하고 터치 header tab·좌우 swipe·Sessions
row focus를 추가했으며, 승인/거부는 Focus 하단의 명시적 버튼에서만
보내도록 바꿔 임의 tap/hold 오발을 제거했다.

상단 배터리는 SY6970 ADC를 연속 변환 모드로 명시적으로 켠 뒤 실제
cell voltage와 charge state를 표시한다. 이 charger에는 fuel-gauge SOC
register가 없으므로 정확한 척하는 퍼센트는 표시하지 않는다.

---
