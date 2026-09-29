# 광고 플랫폼을 활용한 AgentDeck 수익화 조사

조사일: 2026-09-13. 이 저장소의 제품인 AgentDeck을 대상으로 한다. 플랫폼 운영사의 공개 문서, 현재 공개 스토어·마켓플레이스 표기, 저장소의 제품 원칙, GitHub·npm의 공개 지표를 구분해 검토했다. App Store Connect 분석은 로그인된 브라우저에서 직접 읽었다. 광고 계정의 실제 견적, 키워드 검색량, GitHub Pages 방문자 수, Play Console 보고서는 조회하지 않았다. 아무 광고 계정도 만들지 않았고, 코드·사이트·스토어 등록 정보는 바꾸지 않았다.

## 판단

**광고 플랫폼만으로 의미 있는 수익을 내기는 어렵다. AgentDeck은 모든 채널에서 무료이고 MIT 오픈소스이므로, 광고비를 써서 회수할 유료 매출이 없고, 광고를 게재할 지면은 문서 사이트 하나뿐이며 그 트래픽은 게시자 네트워크의 문턱에 한참 못 미친다.** 현재 조건에서 바로 열 수 있는 것은 (1) 문서 사이트의 AdSense, (2) Devices 페이지의 하드웨어 제휴 링크, (3) GitHub Sponsors·npm `funding` 필드 같은 후원 경로다. 셋 다 소액이다. 광고비 집행이 의미를 가지려면 먼저 유료 티어(Elgato 유료 플러그인, 앱 유료 기능)가 있어야 하는데, **Elgato 유료 판매의 정산 수단인 Stripe Connect가 한국을 지원하지 않는다**는 구조적 제약이 확인됐다.

| 방식 | 돈이 들어오는 경로 | AgentDeck 판단 |
|---|---|---|
| 앱·플러그인 내부 광고 | 광고 노출·클릭 → 네트워크 정산 | 채택하지 않음. CLI는 npm 약관이 금지, macOS 앱·Stream Deck 플러그인은 AdMob 미지원, 데크 키·e-ink 면은 지면으로 부적합, "데이터 미수집·분석 SDK 없음" 원칙과 충돌 |
| 문서 사이트 광고 | GitHub Pages 문서 → AdSense 정산 | 가능. 트래픽 문턱 없음. 다만 현재 규모에서는 월 수천~수만 원 수준. EthicalAds·Carbon은 문턱 미달 |
| 하드웨어 제휴 링크 | Devices 페이지 → Ulanzi·Seeed·Divoom·LILYGO 구매 → 수수료 | 가능. 공식 프로그램 존재 확인. 소액이지만 제품 문맥과 가장 자연스러움. Elgato는 공식 페이지 미확인 |
| 후원 | GitHub Sponsors · npm `funding` · Ko-fi 등 | 즉시 가능. GitHub Sponsors는 개인 후원 수수료 0%, 한국 지원. 현재 `FUNDING.yml`·`funding` 필드 없음 |
| 광고비 집행 → 판매 | 검색·커뮤니티 광고 → 유료 구매 | 유료 상품이 없어 회수 매출 0. 유료 티어를 만든 뒤에만 검토 |
| 유료 플러그인 | Elgato Marketplace 판매 → 70% 정산 | 정책상 가능하나 **Stripe Connect 한국 미지원으로 유료 등록 불가**. 해외 법인·대안 정산이 없으면 막힘 |
| 사전 플래시 ESP32 키트 판매 | Tindie·Lectronz 판매 → 5% 수수료 차감 | 광고 수익이 아닌 상품 판매. 재고·배송·지원이 따름. 별도 사업 결정 |

## 제품과 유통의 근거

- 유통 채널은 App Store(Mac·iPhone·iPad), Google Play, Elgato Marketplace, Ulanzi Marketplace, npm, GitHub Releases(ESP32 펌웨어), GitHub Pages 사이트다. 스토어 조회 결과 App Store는 `Free`, Elgato 마켓플레이스 페이지는 `Free`, 스토어 메타데이터 초안도 `Price: Free`다. [README](../../README.md), [스토어 메타데이터 초안](../appstore-metadata-draft.md)
- 라이선스는 MIT다. 무료·오픈소스이므로 "광고 클릭 → 구매" 모델의 분모가 없다. [LICENSE](../../LICENSE)
- 제품 원칙: 앱은 데이터를 수집하지 않고, 분석 SDK(Firebase·Amplitude·Segment)를 넣지 않으며, 옵트인 원격 평가 백엔드를 켠 경우에만 사용자가 지정한 엔드포인트로 내용이 나간다. 광고 SDK는 광고 요청·노출 집계·기기 식별을 수반하므로 이 원칙과 App Privacy 답변을 바꾼다. [App Privacy 답변](../appstore-metadata-draft.md)
- macOS 앱은 App Store 자기완결 불변식(2.5.2/4.2.3)을 유지해야 하며, 외부 도구 프롬프트·설치 유도 UI를 넣을 수 없다. 앱 안에서 "후원해 주세요" 류의 외부 결제 유도도 App Review 3.1.1(외부 결제 링크)의 검토 대상이다. [apple-release 규칙](../../.claude/rules/apple-release.md)
- 공개 지표(2026-09-13 조회): GitHub 스타 232, 포크 47. 최근 14일 저장소 조회 978회(고유 363), 클론 1,981회(고유 320). 유입 상위: Google 247, github.com 78, puritysb.github.io 66, reddit.com 27, npmjs.com 27, t.co 20. npm 최근 30일 다운로드 `@agentdeck/setup` 1,619, `@agentdeck/bridge` 1,724. ESP32 펌웨어 릴리스 자산 다운로드는 릴리스당 수십~122회(esp32-v1.2.2). **GitHub Pages 사이트에는 분석 도구가 없어 사이트 페이지뷰는 미확인이다.** 사이트 유입은 저장소 유입의 근사치로만 쓸 수 있다.
- **App Store Connect 실측(출시 2026-07-21 ~ 09-11, 조회 2026-09-13)**: 아래 절에 정리했다. 최초 다운로드 256, 노출 1.36만, 제품 페이지 조회 639, 전환율 일평균 2.9%.

이 지표는 후원·제휴의 잠재 규모를 가늠하는 근거이며, 광고 수익 예측이 아니다.

### App Store Connect 분석 실측

분석 탭의 90일 범위가 출시일(7월 21일)을 포함하므로 아래는 누적값이다. "개요" 카드는 날짜 범위 선택과 무관하게 같은 값을 보여 주었고, "지표" 페이지의 일별 합계가 그 값과 일치했다(제품 페이지 조회 639). 최근 30일(8/13~9/11)은 별도로 표기한다. 모든 값은 Apple 분석에 잡힌 기기 기준이며, 소스·추천 세부 표는 옵트인 기기만 집계한다.

| 지표 | 출시 이후 누적 | 최근 30일 |
|---|---:|---:|
| 최초 다운로드 | 256 | 127 |
| 재다운로드 | 66 | — |
| 노출 수 | 13,600 | — |
| 제품 페이지 조회 | 639 | 346 |
| 업데이트 | 665 | — |
| 전환율(일평균) | 2.9% | — |

- **기기별 최초 다운로드**: 데스크탑(Mac) 143, iPhone 93, iPad 20. 제품 페이지 조회는 데스크탑 344, iPhone 249, iPad 46. Mac이 절반을 넘고, iPhone 컴패니언이 출시된 8월 12~13일에 조회 99·46회의 단일 스파이크가 있다.
- **국가별 최초 다운로드**: 미국 120, 일본 16, 캐나다 14, 독일 12, 대한민국 11, 영국 11, 대만 10, 튀르키예 7, 오스트레일리아 6. 제품 페이지 조회도 미국 252, 독일 56, 일본 42, 대한민국 41, 캐나다 32, 영국 26 순이다. **북미·서유럽이 과반**이므로 EthicalAds가 전제하는 독자 구성과 일치하고, 한국 트래픽 단가로 할인해 계산할 필요는 없다. 반대로 한국 시장 광고(네이버 등)는 이 제품의 수요와 맞지 않는다.
- **소스별 최초 다운로드(누적)**: 앱 추천 방문 139, App Store 검색 63, App Store 탐색 39, 웹 추천 방문 12, 미상 3. 최근 30일은 앱 추천 69, 검색 41, 탐색 8, 웹 8.
- **앱 추천 방문의 실체**: 이름이 잡힌 추천 앱은 **AppRaven: Apps Gone Free** 하나로, 노출 107·전체 다운로드 81·세션 6이다. 무료 앱 큐레이션 앱에 실려 얻은 다운로드가 최대 단일 소스인데, 세션이 6에 그친다. 즉 다운로드 수의 상당 부분은 "무료라서 받아 본" 사용자이며 활성 사용자 규모로 읽으면 안 된다. 광고비로 이런 다운로드를 산다면 회수는 더 낮다.
- **웹 추천 방문**: puritysb.github.io 노출 11·다운로드 7·세션 5, github.com 노출 28·다운로드 5·세션 32. 자체 사이트에서 오는 사용자는 적지만 세션 전환이 좋다. 사이트가 광고 지면이 아니라 **전환 지면**이라는 근거다.
- **수익화 탭**은 비활성(무료 앱, 수익 없음)이며 캠페인 탭에는 등록된 캠페인이 없다. 평균 유지율은 1일 약 9~10%, 7일 이후 1% 미만으로 표시된다(옵트인 기기만).

이 실측은 두 가지를 바꾼다. 첫째, 앱 내 광고의 규모 계산에 쓸 활성 사용자 수가 수십 명 단위라는 것이 확인되어, 앱 광고 보류 판단이 강화된다. 둘째, 독자 구성이 북미·서유럽 중심이므로 사이트 광고·후원·제휴는 영어 콘텐츠와 달러 기준으로 설계해야 한다.

## 광고를 게재하고 수익을 받는 방법

### 앱·플러그인·CLI 내부 광고: 채택하지 않는다

- **npm**: 오픈소스 약관이 "런타임·설치 시·npm 스크립트를 통해 광고를 표시하는 패키지"와 "README·package.json에 광고를 표시하는 콘텐츠"를 금지한다. 2019년 `funding` 실험 이후 명문화된 규정이다. 허용되는 것은 유료 상품·지원·상용 라이선스 정보와 `funding` 필드다. [npm Open Source Terms](https://docs.npmjs.com/policies/open-source-terms), [package.json funding](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
- **AdMob**: 공식 SDK는 Android·iOS·Unity·Flutter·C++뿐이다. macOS 앱, Stream Deck 플러그인(Node), Ulanzi 플러그인에는 공식 경로가 없다. [AdMob SDK 목록](https://developers.google.com/admob), [비공식 플랫폼 안내](https://developers.google.com/admob/other-platforms)
- **iOS·Android 앱**: 정책상 광고는 허용된다. Apple 2.5.18은 광고를 메인 앱 바이너리로 한정하고(위젯·확장 불가), 연령 적합성, 타기팅 정보 공개, 닫기 버튼, 부적절 광고 신고 기능을 요구한다. Play 광고 정책은 앱 밖 표시·예기치 않은 전면 광고를 금지한다. 다만 iPhone·iPad 앱은 Mac 페어링 컴패니언이고 Android 앱은 e-ink 리더용 런처다. 두 면 모두 사용자가 오래 보는 지면이 아니며, 광고 SDK 도입은 "데이터 미수집" 표기를 바꾼다. [App Review 2.5.18](https://developer.apple.com/app-store/review/guidelines/), [Play 광고 정책](https://support.google.com/googleplay/android-developer/answer/9857753)
- **데크 키·ESP32·e-ink·LED 매트릭스**: 세션 상태를 보여주는 것이 제품이다. 광고를 그리는 순간 상태 가독성이 깨진다. 논외로 둔다.

### 문서 사이트 AdSense: 열 수는 있으나 규모가 작다

- GitHub Pages는 광고를 명시적으로 금지하지 않는다. 금지 대상은 "온라인 사업·전자상거래·SaaS 운영"과 "광고가 콘텐츠의 주된 목적인 경우"다. 문서 사이트에 광고 단위 하나를 두는 것은 두 문서 모두와 양립한다. [GitHub Pages 제한](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [Acceptable Use §4·§10](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
- AdSense 가입 조건은 HTML 접근 권한, 원본 콘텐츠, 만 18세다. 트래픽 최소치는 공표되어 있지 않다. `github.io`는 Public Suffix List에 있어 `puritysb.github.io`를 독립 사이트로 등록할 수 있다는 것이 공식 문서의 논리이나, 실제 승인 마찰은 커뮤니티 보고만 있고 공식 언급이 없다. 커스텀 도메인이면 이 모호함이 사라진다. [AdSense 가입 요건](https://support.google.com/adsense/answer/9724), [서브도메인 사이트 추가](https://support.google.com/adsense/answer/12170421)
- 제약: 사이트는 aquarium-tide 디자인 시스템과 `design/lint.sh` 범위 안에 있다. 외부 스크립트가 그리는 광고 단위는 토큰 규칙 밖에서 렌더되므로, 광고 컨테이너의 위치·크기만 우리가 잡고 그 안은 예외로 문서화해야 한다. 또 사이트가 사용자 데이터를 처리하지 않는다는 현재 프라이버시 안내(`#privacy`)에 쿠키·동의 문구를 추가해야 한다.

### EthicalAds·Carbon: 문턱 미달

| 네트워크 | 공식 조건 | 적용 판단 |
|---|---|---|
| EthicalAds | 개발자 중심 사이트, **월 50,000 페이지뷰 이상**, 신청→테스트→승인. 게시자는 광고주 청구액의 70%를 받고, 대부분 CPM $2.25~2.75(북미·서유럽 독자 과반 전제). 최소 지급 $50 | 사이트 트래픽 미확인이나 저장소 조회가 월 2천 회대이므로 문턱의 수십 분의 1. 지금은 신청 불가 |
| Carbon (BuySellAds) | 신청·심사제, "존경받는 개발자·디자이너" 대상. 최소 트래픽·수익 배분 미공표. 광고주 측 미디어킷은 월 100만 노출을 권장 | 초대급. 현재 검토 대상 아님 |

출처: [EthicalAds 게시자](https://www.ethicalads.io/publishers/), [FAQ](https://www.ethicalads.io/publishers/faq/), [계산기](https://www.ethicalads.io/publishers/calculator/), [Carbon 가입](https://www.carbonads.net/join), [Carbon 미디어킷](https://www.carbonads.net/more-info)

참고로 EthicalAds 광고주 가격표(2026 Q3)는 AI/ML 주제의 CPM을 지역별 $0.80~7.25로 제시한다. AgentDeck 독자층이 "AI 코딩 에이전트 사용자"이므로, 문턱을 넘긴다면 이 주제의 70%가 게시자 몫이 된다. 한국·일본 등 동아시아 트래픽은 같은 표에서 $1.90(AI/ML)로 북미의 4분의 1이다. [광고주 프로스펙터스](https://www.ethicalads.io/prospectus/ethicalads-advertiser-prospectus.pdf)

### 사이트 광고 수익의 규모 계산

시장 단가 예측이 아닌 민감도 분석이다. 페이지 RPM은 페이지뷰 1,000회당 게시자 수익으로 정의하며, 충족률·노출수·배분이 이미 반영된 값이므로 다시 차감하지 않는다.

| 월 사이트 페이지뷰 | 페이지 RPM 1,000원 | 페이지 RPM 3,000원 | 페이지 RPM 5,000원 |
|---:|---:|---:|---:|
| 2,000 (저장소 조회 근사) | 2,000원 | 6,000원 | 10,000원 |
| 10,000 | 10,000원 | 30,000원 | 50,000원 |
| 50,000 (EthicalAds 문턱) | 50,000원 | 150,000원 | 250,000원 |

월 광고 매출 100만원에는 RPM 3,000원 가정에서 약 33만 페이지뷰가 필요하다. 저장소 조회 기준 현재 규모의 150배 이상이다. 문서 사이트를 광고 수익원으로 키우려면 "Stream Deck으로 Claude Code 다루기", "ESP32 e-ink 상태판 만들기" 같은 검색 유입 콘텐츠를 지속 생산해야 하며, 이는 제품 개발과 별개의 콘텐츠 사업이다.

## 하드웨어 제휴 링크: 제품 문맥에 가장 맞는 소액 경로

Devices 페이지는 29개 표면의 구매 대상 하드웨어를 이미 나열한다. 여기에 제휴 링크를 붙이는 것은 사용자 행동을 바꾸지 않고, 앱·CLI의 원칙도 건드리지 않는다.

| 벤더 | 공식 프로그램 | 조건 | 상태 |
|---|---|---|---|
| Ulanzi (D200H·D200X) | 있음 | 최대 12%, 쿠키 30일. ShareASale·GoAffPro·Impact 경유 | 확인 |
| Seeed Studio (TRMNL·XIAO) | 있음 | 기본 3%, XIAO 시리즈 8%, 디스플레이 5~10%, 쿠키 45일, 최소 지급 $50, 분기 정산 | 확인 |
| Divoom (Pixoo) | 있음 | 공식 페이지에 조건 없음. 네트워크 등록 정보상 12%, 쿠키 30일 | 네트워크 정보만 |
| LILYGO (T-Display·T-Embed) | 있음 | 2%, 쿠키 30일 (Bixgrow) | 확인 |
| M5Stack | 제휴 없음 | 총판 프로그램만(월 $5,000 구매 조건) | 해당 없음 |
| Elgato/Corsair (Stream Deck) | 네트워크 등록만 | 공식 제휴 페이지 미발견(3개 URL 404). FlexOffers 등에 등록. 제3자 3~5% | 미확인 |
| Amazon Associates | 있음 | 카테고리별 요율표가 로그인 뒤에 있어 공식 수치 미확인 | 미확인 |

출처: [Ulanzi](https://www.ulanzi.com/pages/ulanzi-affiliate-program), [Seeed](https://www.seeedstudio.com/blog/affiliate-program/), [Divoom](https://divoom.com/pages/collab), [LILYGO](https://lilygo.cc/en-us/pages/join-us), [M5Stack 총판](https://m5stack.com/distributor), [Elgato 파트너십](https://www.elgato.com/us/en/s/partnerships)

민감도: 월 Devices 페이지 방문 V, 링크 클릭 5%, 클릭 후 구매 2%, 평균 주문 10만원 가정 시 월 수수료 = V × 100원 × 요율.

| 월 Devices 방문 | 요율 3% | 요율 8% | 요율 12% |
|---:|---:|---:|---:|
| 1,000 | 3,000원 | 8,000원 | 12,000원 |
| 10,000 | 30,000원 | 80,000원 | 120,000원 |

클릭률·구매율·주문액은 모두 가정이다. 스토어 메타데이터의 "Anthropic·Elgato·Divoom·Ulanzi·Waveshare 등과 제휴·후원 관계가 없다"는 문구는 제휴 링크를 넣는 순간 갱신해야 하며, 한국 표시광고법과 미국 FTC 기준에 따라 제휴 링크임을 페이지에 표시해야 한다.

## 후원: 지금 바로 열 수 있는 경로

| 경로 | 수수료 | 조건 | 현재 상태 |
|---|---|---|---|
| GitHub Sponsors | 개인 후원 0%, 조직 후원 최대 6% | 지원 지역 거주. **한국은 공식 지원 목록에 있음** | `.github/FUNDING.yml` 없음 |
| npm `funding` 필드 | 없음 | `npm fund`가 표시. 광고가 아니므로 약관 허용 | `@agentdeck/*` 어디에도 없음 |
| Open Source Collective | 호스트 수수료 10% + 결제 수수료 | 오픈소스 라이선스, **조직 저장소 필수**, 관리자 2인 권장 | `puritysb/` 개인 계정이라 해당 없음 |
| Buy Me a Coffee | 5% + Stripe 2.9%+$0.30 + 지급 0.5% | 없음 | 미개설 |
| Ko-fi | 일회성 팁 0%, 멤버십·샵 5%, Gold $12/월 | 없음 | 미개설 |

출처: [GitHub Sponsors](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors), [OSC 수수료](https://docs.oscollective.org/welcome-and-introduction-to-osc/fees), [OSC 가입 기준](https://docs.oscollective.org/interested-in-joining-osc/acceptance-criteria), [Buy Me a Coffee](https://help.buymeacoffee.com/en/articles/8105744-how-to-calculate-charges-on-your-payment), [Ko-fi](https://help.ko-fi.com/hc/en-us/articles/360002506494-Does-Ko-fi-take-a-fee)

GitHub Sponsors의 한국 정산은 2022년에 Stripe 지역 선택 문제가 보고됐다가 해결된 것으로 해당 스레드에 기록되어 있다. 개설 시 실제 정산 계좌 등록까지 확인해야 한다. [커뮤니티 스레드](https://github.com/orgs/community/discussions/27547)

## 광고비를 지출해 판매를 늘리는 방법: 유료 상품이 생긴 뒤의 일

현재는 광고 클릭이 만들어내는 매출이 0원이다. 무료 다운로드를 광고비로 사는 것은 지표만 오르고 회수가 없다. 따라서 채널 조사는 "유료 티어가 생겼을 때" 쓸 참고표로만 남긴다.

| 채널 | 공식 조건 | 판단 |
|---|---|---|
| Reddit Ads | 일 최소 $5(셀프서브). 권장 광고그룹 $50/일 | 개발자 커뮤니티 도달. 유료 상품 후 1순위 검증 채널 |
| Google Ads | 최소 예산 없음(Demand Gen만 2026-04부터 $5/일) | "stream deck claude code" 류 검색 의도. 검색량은 Keyword Planner 로그인 필요 |
| EthicalAds 광고주 | 최소 $1,000, AI/ML CPM $4.40~7.25 | 개발자 네트워크 중 유일한 $5k 미만 진입 |
| Carbon 광고주 | 개발자 CPM $6, 월 100만 노출 권장, 선결제 | 규모 부적합 |
| Product Hunt | 런칭 무료. 유료 광고 $5,000~10,000부터 | 런칭만 활용 |
| Show HN | 무료 | 비용 0. 이미 t.co·reddit 유입이 있으므로 우선 |
| Apple Ads | 계정 개설에 **iPhone·iPad 앱 필요**(AgentDeck은 충족). Advanced는 탭당 과금·상한 없음, Basic은 설치당 과금·앱당 월 $10,000 상한. Mac App Store 노출은 대상 아님 | iOS 컴패니언 홍보용. Mac 앱 유입엔 무관 |

출처: [Reddit 비용](https://advertising.reddithelp.com/en/categories/billing-payment/how-much-do-reddit-ads-cost), [Google Ads 예산](https://support.google.com/google-ads/answer/2375454), [Demand Gen 최소 예산](https://ads-developers.googleblog.com/2026/02/minimum-budget-requirement-for-demand.html), [EthicalAds 가격](https://www.ethicalads.io/advertisers/pricing/), [Product Hunt 광고](https://help.producthunt.com/en/articles/7950405-ad-campaigns), [Show HN](https://news.ycombinator.com/showhn.html), [Apple Ads 비교](https://ads.apple.com/app-store/help/advanced/0001-how-apple-search-ads-works/), [Apple Ads 계정 조건](https://ads.apple.com/app-store/help/get-started/0052-solve-setup-and-access-issues)

### 유료 티어가 생겼을 때의 손익 기준

Elgato Marketplace는 메이커가 가격을 정하고 70%를 받는다(Elgato 30%). 앱 스토어는 Small Business Program·Play 15% 구간이 적용된다(연 $100만 이하). $4.99 플러그인이라면 건당 기여이익은 약 $3.49다.

| 광고 클릭 → 유료 구매율 | 손익분기 클릭 단가 ($3.49 기준) |
|---|---|
| 1% | $0.035 |
| 3% | $0.105 |
| 5% | $0.175 |

Reddit·Google의 실제 CPC가 이 값보다 높으면 유료 광고는 손실이다. 개발자 대상 CPC가 수십 센트에서 수 달러인 것이 일반적이므로, **$5 안팎의 일회 구매 상품은 유료 광고로 팔 수 없다**는 결론이 먼저 나온다. 광고비 집행이 성립하려면 구독·팀 라이선스처럼 건당 기여이익이 수만 원 이상인 상품이어야 한다.

출처: [Elgato 수익 배분](https://docs.elgato.com/monetization/revenue-share/), [Apple SBP](https://developer.apple.com/app-store/small-business-program/), [Play 서비스 수수료](https://support.google.com/googleplay/android-developer/answer/112622)

### 정산 제약: Stripe Connect와 한국

Elgato는 "당신의 국가가 Stripe Connect를 지원하지 않으면 유료 상품을 등록할 수 없고 무료만 가능하다"고 명시한다. Stripe의 사업자 지원 국가 목록에 한국은 없고, Connect 크로스보더 지급도 미국·영국·EEA·캐나다·스위스 간으로 한정된다. 즉 **한국 개인 개발자는 현재 Elgato 유료 플러그인을 등록할 수 없다.** Tindie도 Stripe Connect 또는 Wise 지급이므로 Wise 경로만 남는다. GitHub Sponsors는 자체 지역 목록에 한국을 포함하므로 예외다. [Elgato Stripe 안내](https://docs.elgato.com/monetization/stripe/), [Stripe 지원 국가](https://stripe.com/global), [Stripe Connect 크로스보더](https://docs.stripe.com/connect/cross-border-payouts), [Tindie 판매](https://www.tindie.com/about/sell/)

## 하드웨어 키트 판매: 광고가 아닌 별도 사업

Tindie는 유료 주문당 5%(등록 무료), Lectronz는 5%(첫 5주문 무료, 카드 수수료 별도), Crowd Supply는 수수료율 미공표다. TRMNL 7.5" e-ink나 ESP32 패널을 사전 플래시해 파는 모델은 가능하지만 재고·배송·보증·지원을 동반한다. 이 보고서의 질문(광고 플랫폼)과는 다른 결정이므로 기록만 한다. [Tindie](https://www.tindie.com/about/sell/), [Lectronz](https://lectronz.com/pages/sell), [Crowd Supply 약관](https://www.crowdsupply.com/terms-of-use)

## 추천 순서

1. **후원 경로를 연다(비용 0, 하루).** `.github/FUNDING.yml`에 GitHub Sponsors, `@agentdeck/*` `package.json`에 `funding` 필드. 앱 안에는 넣지 않는다(App Store 3.1.1·자기완결 불변식).
2. **Devices 페이지에 제휴 링크를 붙인다(수일).** Ulanzi·Seeed·LILYGO는 공식 프로그램 가입, Divoom·Elgato는 네트워크 조건 확인 후. 제휴 표시 문구와 스토어 메타데이터의 "제휴 없음" 문구를 같은 커밋에서 갱신한다.
3. **사이트에 측정을 먼저 넣는다.** 페이지뷰를 모르면 AdSense·EthicalAds 판단이 불가능하다. 쿠키 없는 집계(서버 로그 없는 Pages에서는 프라이버시 친화 스크립트) 도입과 프라이버시 안내 갱신을 함께 한다. 3개월 실측 후 AdSense 신청 여부를 정한다.
4. **광고비 집행은 유료 티어 결정 뒤로 미룬다.** 그 결정에는 Stripe 한국 미지원(Elgato 유료 등록 불가)이 선행 조건이며, 건당 기여이익이 수만 원 이상인 상품 형태(구독·팀)가 아니면 광고 회수가 성립하지 않는다.

## 미확인·차단 항목

- GitHub Pages 사이트 실제 페이지뷰(분석 도구 없음)
- Google Play 다운로드 수(Play Console 미조회). App Store 쪽은 위 실측으로 대체
- Amazon Associates 공식 요율표(로그인 필요), Elgato/Corsair 공식 제휴 조건(미발견), Crowd Supply 수수료율(미공표)
- Reddit·Ko-fi 공식 도움말은 직접 조회가 차단되어 검색 색인의 인용문에 의존
- Ulanzi Studio 스토어의 유료 플러그인 옵션(SDK 라이선스는 상용 허용, 스토어 유료 판매 페이지 미발견)
