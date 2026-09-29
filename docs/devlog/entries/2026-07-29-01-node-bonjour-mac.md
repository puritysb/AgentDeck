# 2026-07-29 — Node Bonjour가 Mac의 로컬 호스트명을 자기 충돌시키던 문제 수정

이슈 #67 제보에서 `agentdeck daemon start` 직후 macOS가
`NL13ENABL9DHKC2-3.local`을 `...-4.local`로 바꾸고 "already in use on this
network" 팝업을 띄우는 재현 증거가 들어왔다. AgentDeck에는 `scutil`,
`sethostname` 같은 변경 경로가 없었지만, 원인은 mDNS 광고 자체에 있었다.

`bonjour-service`는 publish 설정에 `host`가 없으면 `os.hostname()`을 SRV
target과 모든 A/AAAA 레코드 이름으로 쓴다. macOS에서는 이 값이 시스템
mDNSResponder가 이미 소유한 `.local` 이름이므로, 별도 user-space responder의
광고를 충돌로 오인한 mDNSResponder가 LocalHostName에 숫자를 계속 붙였다.
같은 라이브러리 계보에는 단순 `bonjour.publish()`만으로 동일 팝업이 뜨는
미해결 upstream 이슈(watson/bonjour#24)도 남아 있다.

Node 데몬은 이제 프로세스마다 임의의 `agentdeck-<uuid>.local` service host를
한 번 만들고, 최초 광고와 sleep/wake·IP 변경 복구 광고에서 같은 값을 쓴다.
서비스 instance/TXT/port는 그대로라 iOS·Android·ESP32 discovery 계약은
변하지 않고, 시스템 호스트명만 더 이상 A/AAAA record owner로 주장하지 않는다.

회귀 테스트는 publish 설정에 시스템 hostname이 들어가지 않는 것과 복구
재광고에서 service host가 안정적인 것을 고정한다. mDNS 신규/기존 테스트
18개 및 bridge typecheck 통과. npm public package 네 개를 `1.0.3`으로
동기화해 배포한다.
---
