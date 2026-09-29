# 2026-04-11 — D200H Helper Promotion 실패 시 Local Daemon 복구

### 문제
`startBundledD200HHelper()`가 `stop()` 호출 후 helper 프로세스를 spawn했는데, helper가 6초(20×300ms) 내에 health 응답하지 못하면 helper만 종료하고 끝남. local in-process daemon은 이미 stop된 상태로 남아 dashboard/CLI/D200H 모두 끊김. 사용자가 Settings에서 수동으로 재시작할 때까지 앱 전체가 "daemon down" 상태.

### 해결
`DaemonService.startBundledD200HHelper()` 의 20-probe fail 경로에서 `stopOwnedExternalDaemonIfNeeded()` 직후 `start()` 재호출. `d200hHelperPromotionAttempted` 플래그는 entry 시점에 이미 true로 설정되어 있어 health monitor가 즉시 같은 promotion을 다시 시도하지 않음.

errorMessage는 `"... Reverted to local daemon."` 으로 명시해 사용자가 진단 가능하도록.

### 핵심 설계 결정
- **stop() 후 spawn 실패 = local daemon 복구 의무**: helper promotion은 "최선의 노력" 경로이지 fail-stop이 아님. fall-through fallback이 항상 local daemon이어야 함.
- **무한 promotion 방지**: 기존 `d200hHelperPromotionAttempted` 플래그 유지로 충분. `restart()` 시점에만 false로 리셋되므로 사용자 의도가 명시적으로 표현될 때까지 1회만 시도.
