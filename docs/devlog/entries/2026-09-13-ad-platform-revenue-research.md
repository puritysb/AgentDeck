# 2026-09-13 — 광고 플랫폼 수익화 조사: 무료 제품에는 회수 매출이 없고, 유료 플러그인은 Stripe 한국 미지원으로 막힌다

광고 플랫폼으로 AgentDeck에서 수익을 낼 수 있는지 조사해
[docs/marketing/ad-platform-revenue-research-2026-09-13.md](docs/marketing/ad-platform-revenue-research-2026-09-13.md)에
기록했다. 채택된 정책은 없다. 카탈로그에는 제외 사유로 등록했다.

### 결론

- 모든 채널이 무료·MIT·분석 SDK 없음이므로 광고비를 써서 회수할 매출이 없다. npm 약관은 터미널 광고를 금지하고, AdMob은 macOS 경로가 없으며, 데크·e-ink 면은 광고 지면이 아니다.
- 지금 열 수 있는 것은 문서 사이트 AdSense, Devices 페이지의 하드웨어 제휴 링크(Ulanzi·Seeed·LILYGO 공식 프로그램), GitHub Sponsors(한국 지원, 개인 후원 수수료 0%)뿐이며 모두 소액이다.
- **Elgato Marketplace 유료 플러그인은 Stripe Connect로만 정산되고 Stripe는 한국을 지원하지 않는다.** 유료 티어 논의는 정산 수단부터 확인해야 한다.

### App Store Connect 실측

출시(7/21) 이후 최초 다운로드 256(Mac 143·iPhone 93·iPad 20), 노출 1.36만, 제품 페이지 639. 국가는 미국 120으로 과반이고 한국은 11이다. 최대 단일 유입은 무료 앱 큐레이션 앱 AppRaven(다운로드 81, 세션 6)이라 다운로드 수를 활성 사용자로 읽으면 안 된다. 개요 카드는 날짜 범위와 무관하게 누적값을 보여 주며, 지표 페이지의 일별 합계로 대조했다.
