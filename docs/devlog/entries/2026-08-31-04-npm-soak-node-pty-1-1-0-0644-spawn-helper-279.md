# 2026-08-31 — npm 실설치 soak가 node-pty 1.1.0의 0644 spawn-helper를 잡는다 (#279)

#277을 합친 정확한 prospective tag commit `70d455cb`에서 네 tarball을 다시
pack해 `/opt/homebrew/bin/agentdeck`에 설치했다. package version, native addon
import, tarball↔installed `dist/cli.js` hash는 모두 정상이었지만 실제
`agentdeck claude --weight 7 -c ...`가 첫 PTY spawn에서 `posix_spawnp failed`로
종료했다. import-only smoke가 실제 기능을 증명하지 못하는 정확한 사례다.

실측 원인은 기존 오류 문구가 주장한 Node ABI 불일치가 아니었다.
`node-pty@1.1.0`의 npm tarball 자체가 macOS arm64/x64 `spawn-helper`를 0644로
싣고 있고(상류 microsoft/node-pty#850/#919), 설치본도 correct-arch Mach-O지만
execute bit가 없었다. `@agentdeck/setup`도 `npm install` exit code만 보므로 이
runtime failure를 감지하지 못했다. source checkout 전용 `scripts/install.sh`의
chmod는 전역 npm 설치 경로를 고치지 않는다.

`PtyManager`는 이제 dynamic import 전에 실제 resolve된 node-pty package root의
prebuilt/source helper를 찾고, regular file에 execute bit가 하나도 없을 때만
기존 read bit 범위에 대응하는 execute bit만 더한다. symlink는 건드리지 않고
macOS 외 플랫폼은 no-op이다.
수정할 권한이 없으면 정확한 package path와 chmod 조치를 말하며, 그래도 남는
`posix_spawnp`에만 setup/source-rebuild 안내를 준다. 0644→0755, 기존 0750 보존,
source-build fallback, non-mac no-op, symlink 거부를 독립 테스트로 고정했다.
