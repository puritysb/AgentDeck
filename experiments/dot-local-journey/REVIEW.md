# Dot local journey review

Reviewed **2026-10-26 KST**. This is an evidence audit and heuristic walkthrough for
internal product review. It is **not a usability study**, a measured conversion
funnel or acceptance of ordinary-user installation. The interactive journey is a proposal; its simulated transitions must never count
as live OAuth, installed-plugin, network or hardware evidence. The introduction
now also includes a clearly labeled screenshot of the real native connection GUI
and the installed-package findings below.

## Decision and intended value

Continue developing the local route. It matches the publisher's preference to
avoid operating a relay for users' traffic, and actual Dot execution has reached
an isolated native host. Public release remains blocked by supported distribution,
automatic tool exposure, consumer onboarding and production-app acceptance.

The prototype and introduction use **릴리즈 체크리스트 요약** as their shared
scenario. The user previews this selected synthetic context before asking Dot to
summarize the remaining checks:

> 로컬 요청 왕복: 확인됨
>
> 일반 사용자 설치: 미검증
>
> 실제 장비의 결과 표시: 미검증

AgentDeck then illustrates the request's working and completed reports. The example
summary identifies the two unverified items in this selected excerpt; it is not a
complete release checklist or a claim that only two release gates remain. This is
an illustrative product scenario, not a completed live checklist-summary test.
The measured synthetic arithmetic request proves correlated read/report transport,
not the quality of summarization or ordinary-user onboarding.

## Evidence boundary

| Evidence level | What is established | What it cannot establish |
|---|---|---|
| Actual Dot execution | Six native-client commands returned exit 0; the real context marker and 26 + 84 + 12 = 122 matched the final request report | Installed-plugin discovery or an ordinary user's GUI setup |
| Native development fixture | Dedicated sandbox/Keychain and original Swift host; deny/approve, restart, post-initial-expiry read and revoke worked | Production app ownership, Store signature, device delivery or consumer signing |
| Source and focused tests | Native client policies and bounded transport are exercised by its tests | All operating-system, account, lifecycle and usability conditions |
| Proposed journey | Screens can expose permission boundaries, selected context, request identity and recovery actions | A rendered screen is not implemented product behavior |

The native test used explicit CLI invocation by Dot's connected-Mac task. It did
not send a claim or report from the validation task in Dot's place. The access
read 419.8 seconds after initial approval shows the refresh path was used beyond
the initial 300-second token lifetime; the exact refresh time was not instrumented.
Historical tunnel and Node-client evidence must remain separate from this result.

Source evidence: [distribution decision](../../docs/dot-distribution-decision.md#local-executor-checkpoint-2026-10-25),
[native client](../../integrations/chatgpt-local/native/README.md),
[development host](../dot-native-local-host/README.md).

## Heuristic findings and changes

| Priority | Problem found in the existing explanation or scenario | Improvement | Acceptance evidence still needed |
|---|---|---|---|
| P0 | The Korean overview called the old tunnel experiment the current route and said native feasibility still needed proof | Updated the explanation to the 2026-10-26 local result, kept historical evidence distinct, and retained public-release limitations | Review against future implementation and distribution changes |
| P0 | “Local” can imply no data leaves the Mac | Explain selected context/results are processed by OpenAI before the sharing decision; say no publisher relay instead of offline or local-only processing | Independent users can correctly name who receives the shared context |
| P0 | A single “Connected” badge can imply first-request success | Separate environment readiness, consent, and the first correlated Dot result | The UI must not claim functional readiness from token issuance alone |
| P0 | Revoke can sound like canceling the task or deleting every copy of shared data | Explain AgentDeck grant revocation, Dot computer permission, task cancellation and external data controls separately | After revocation, further access fails and the UI makes no cancellation or external-deletion claim |
| P1 | Generic unavailable/auth text can send users into repeated consent even when the Mac is merely offline | Preserve unavailable, denied/expired authorization, and unknown outcomes; offer one relevant recovery action | Failure injection and locked/closed-app scenarios in the actual product |
| P1 | A stale working report can look like ongoing global Dot activity | Pair the request title with report time; stop active animation when fresh state is unknown; preserve prior completion as history | Sleep/network interruption never generates a completion or endless working animation |
| P1 | Technical identifiers dominate the demonstration | Show a meaningful request title and selected content; keep request identifiers in details and logs | Users can locate the right result without copying tokens or editing config |
| P1 | Installation success can hide unsupported account or execution contexts | Check prerequisites explicitly and show supported next actions without inventing deep links or self-service availability | Fresh eligible and ineligible account/profile runs |

These are heuristic findings from implementation, documentation and scenario
review. No participant counts, completion-time improvements, satisfaction scores
or task-success rates have been measured.

## Scenario acceptance matrix

“Measured” below refers only to the isolated native fixture. All proposed UI
acceptance requires the production product and the declared deployment path.

| Scenario | Expected user-facing behavior | Measured evidence | Required next acceptance |
|---|---|---|---|
| First use | Prepare the supported apps/plugin, connect the Mac in ChatGPT, review local scopes, compare the consent code, and approve | Fixture consent and native Keychain custody passed | GUI-only install on two independent eligible accounts and clean Mac profiles, with no API key, terminal or tunnel setup |
| Selected request | Preview exactly what will be shared; identify OpenAI as the recipient of selected context/results; send only the selected request | Synthetic context read and correlation passed | Actual product context selector and bounded preview; unrelated requests remain inaccessible |
| Normal result | Show the shared request waiting, receiving a working report, then a completed report and result time | Actual Dot and host both observed working sequence 1 and completed sequence 2 | Installed native plugin used automatically in the supported Dot execution context; product and claimed hardware display |
| Consent denied | Leave the connection unauthorized, keep other AgentDeck functions usable, and allow a later intentional retry | Denial produced authorization required and zero grants | Actual product wording, keyboard navigation and retry path |
| Mac unavailable | Explain that this Mac cannot currently serve the local request; do not claim the cloud Dot stopped | Official local-computer prerequisites; no complete product outage test | Offline and ChatGPT-exit tests with bounded failure and recovery |
| Stale report | Retain the last report as history, show report age and unknown current progress, stop working animation | Behavior is a presentation requirement, not established by the native transport test | Simulated stale input followed by actual sleep/network tests |
| Expired or interrupted authorization | Distinguish consent renewal from temporary reachability; do not replay a possibly consumed refresh token | Successful post-initial-expiry read; interruption policy is tested separately in the client | Real expiry, Keychain denial, crash during refresh, and safe GUI reconnect |
| App restart | Restore the grant and prior result, then establish availability from a fresh call | New host process restored grant and completion; later read passed | Production daemon ownership and signed app restart |
| Revoke | Block future access for this AgentDeck connection; distinguish local cleanup from external copies | Old client failed, disconnect succeeded, host had zero test grants/requests | Product revocation wording and no cross-grant impact |
| Reconnect | Let the user deliberately establish a new scoped connection without altering unrelated grants | Existing Node grants survived temporary-test cleanup | Account switch, separate connections, concurrent clients and upgrade continuity |

The local route needs the Mac online and ChatGPT running. A missing fresh report
alone cannot prove the Mac is offline; use an authoritative connection signal or
state that availability is unknown. Window closure is not process termination.
A successful local connection is not evidence that every Dot cloud task is visible.

## Permission and data copy

Proposed consent text:

> 선택해 공유한 요청의 문맥을 읽고, 해당 요청의 진행 상황과 결과를 보고할 수 있어요.
> 공유한 문맥과 결과는 OpenAI가 처리해요. AgentDeck 개발자의 중계 서버는 거치지 않아요.

Proposed revocation text:

> 이 AgentDeck 연결의 이후 접근을 막아요. Dot의 Mac 접근 권한은 ChatGPT에서 별도로
> 관리해요. 이미 전달된 문맥이나 대화는 이 동작으로 삭제되지 않아요.

Do not label revocation “stop Dot,” “delete everything,” or “remove all Mac access.”
Do not claim a read/report scope restricts the separate, already granted computer
permission. Never preselect all conversations or imply connection alone shares
transcripts. Do not promise completion from a timeout, animation or model label.

## Introduction and demonstration requirements

- Label proposed UI as **사용 흐름 제안 · 미출시** on each relevant scene. An intro
  clip must not crop away that label or turn a proposed button into an installation promise.
- Keep the current measured proof visible separately: native explicit invocation,
  isolated host, synthetic result 122. Do not replace it with a made-up real customer story.
- Use a useful task example without claiming it was the measured native trial.
- Show a denied or stale path alongside the happy path, plus revocation scope.
- Explain OpenAI processing and Mac availability in the journey, not only in tiny footnotes.
- Use actual product assets or clearly labeled prototypes. Do not fabricate hardware
  photography, installed-plugin screens, approval receipts or consumer screenshots.
- Evaluate content coverage and legibility on the rendered presentation and actual
  prototype viewport. Visual polish cannot close the distribution or runtime gates.

## Release assessment

The prepared native request path is feasible. The ordinary-user experience is not
ready to advertise as install-and-consent. Prioritize a supported plugin packaging
and authorization contract, then production onboarding and independent-user trials.
Do not broaden to automatic Events wakeups, global Dot telemetry or more device
surfaces to avoid resolving this boundary.

[OpenAI desktop-only submission](https://developers.openai.com/plugins/deploy/desktop-only)
requires approved-partner eligibility and organization allowlisting for local MCP,
then review. Desktop-only plugins are installed from the desktop app and can be
mentioned only in locally running threads. This does not establish arbitrary
Dot-task tool propagation. [Dot computer access](https://learn.chatgpt.com/docs/dots/computers-and-apps)
requires a connected personal computer online with ChatGPT open; computer access
and plugin/account grants are separate.

The [release plan](../../docs/dot-store-release-plan.md#release-gates-in-order) remains
the acceptance checklist. This review improves the explanation and proposed
experience; it does not promote the feature into standard Apple builds.

## Implementation follow-through — 2026-10-26

The review led to a real separate SwiftUI consent/revocation app and signed native
plugin packaging. Code-matched GUI consent, shared Keychain use by the installed
stdio executable, a six-call request round trip by the existing Dot-created worker
(sum 158), GUI revocation and denied later access passed in the prepared fixture.
The fixed fixture window also restored dynamic controls after a layout stall.
DotPreview settings now distinguish approved connections from request activity,
explain stale reports and revocation, and offer bounded request-reference copying.

The installed plugin did not become an automatically exposed native tool in the
tested worker's new turns. Public eligibility, clean-user setup and actual product
and device acceptance remain open. The introduction includes an actual GUI capture;
the interactive journey remains a simulation. Detailed evidence is maintained in
the [native client checkpoint](../../integrations/chatgpt-local/native/README.md#gui-and-package-acceptance-2026-10-26-kst)
and [distribution decision](../../docs/dot-distribution-decision.md#installed-native-package-checkpoint-2026-10-26).
