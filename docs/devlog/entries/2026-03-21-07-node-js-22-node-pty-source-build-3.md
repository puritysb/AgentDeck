# 2026-03-21 — Node.js >=22 + node-pty source build (#3)

### 문제
Node.js 24 (LTS)에서 prebuilt node-pty 바이너리 ABI 불일치 → `posix_spawnp failed` 에러로 bridge 시작 불가. prebuilt 디렉토리는 존재하지만 Node 24 ABI와 호환되지 않음.

### 해결
1. **engines `>=22`**: Node 20 EOL (2026-04) 앞두고 최소 버전 상향. setup.ts, install.sh, package.json, README 일괄 변경
2. **Setup source build**: `npm_config_build_from_source=true` 환경변수로 node-pty 설치 시 항상 소스 빌드 강제. prebuild ABI 문제 원천 차단
3. **PtyManager 에러 안내**: `posix_spawnp` 에러 catch → rebuild 명령어 + `npx @agentdeck/setup` 재설치 안내

### 교훈
- node-pty `prebuild.js`는 디렉토리 존재만 체크, 실제 바이너리 호환성 검증 없음
- `npm_config_build_from_source=true`가 prebuild.js에서 직접 참조하는 환경변수 — npm CLI 플래그(`--build-from-source`)는 `node-pre-gyp` 전용
- 네이티브 addon은 Node major 버전마다 ABI 변경 가능 — LTS 버전만 지원하되 source build 기본 전략이 안전

---
