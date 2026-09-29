# 2026-09-21 — Apple test host and pipeline failure propagation

During Apple 1.4.0 preparation, PR #352's Apple CI reported success, but its
macOS test log showed that the macOS 15.7.9 runner could not execute the macOS
26 deployment target. `xcodebuild` was piped to `xcbeautify` under implicit
`bash -e`; the formatter's success hid the failing test command.

The macOS test job now uses `macos-26`, supported by
[GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The workflow explicitly selects `shell: bash`, enabling GitHub's `-o pipefail`
behavior for every build/test pipeline. Archive jobs do not use xcbeautify and
were not affected by this exit-code masking.

The earlier PR's green test-macos badge must not be counted as an executed
suite. The locally executed 32 Codex installer/MiniToml tests and 30 usage and
preview tests remain valid. The release tag is held until the corrected CI
executes the native suite and the signed archive gates pass.
