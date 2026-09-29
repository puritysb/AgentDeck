# 2026-03-02 — E-ink Tank Status 뷰 재설계

### 문제
`EinkStatusCompact`가 3줄 monospace 텍스트로 모든 정보를 표시:
1. `OAuth✓ ●Bridge UP:0:03` — Bridge 연결/업타임은 불필요한 정보
2. `Olla✓` — 말줄임으로 가독성 저하
3. Unicode 게이지 바 (`██░░`) — e-ink 16-level 그레이에서 채움/빈칸 구분 어려움
4. 토큰 수/비용 미표시, `modelCatalog` 미활용
5. 정보 위계 없음 (모두 동일 monoStyle)

### 해결
- **3-section 분리**: Rate Limits + Tokens & Cost + Models — 시각적 섹션 헤더(Bold, letterSpacing 1sp)
- **Compose Box 게이지바**: `EinkGaugeBar` — black fill + white empty + black `border(1.dp)`. Unicode 문자 대비 e-ink 대비 극대화, 디더링 아티팩트 0
- **`BoxWithConstraints` 적응 레이아웃**: >700dp = 3-column (IDLE 전체 너비), ≤700dp = 세로 스택 (ACTIVE 좁은 영역)
- **`modelCatalog` 활용**: OAuth 연결 + 사용 가능 모델 전체 목록 표시 (말줄임 없음)
- **billingType 분기**: API 사용자는 Rate Limits 숨기고 "API Key" 표시
- **ACTIVE 모드 weight 균등화**: context/status 55%/45% → 50%/50%
- **Refresh trigger 확장**: `usage`만 → `usage + oauthConnected + ollamaStatus + modelCatalog`

### 교훈 / 핵심 설계 결정
- **E-ink 게이지 = Compose Box**: Unicode block 문자는 e-ink EPD에서 그레이레벨 차이가 미미하여 사실상 구분 불가. 순수 흑백 Compose Box가 최적
- **적응 레이아웃 기준**: 700dp는 Crema S 1072dp landscape의 78%(우측 컬럼) ≈ 836dp → wide, ACTIVE 45% ≈ 376dp → narrow

---
