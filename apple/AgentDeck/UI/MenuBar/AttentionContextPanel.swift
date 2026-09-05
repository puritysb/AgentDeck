#if os(macOS)
import SwiftUI
import CoreText

@MainActor
private enum AttentionContextFonts {
    static let register: Void = {
        for name in ["IBMPlexSansKR-Regular", "IBMPlexSansKR-Bold", "JetBrainsMono-Regular"] {
            if let url = Bundle.main.url(forResource: name, withExtension: "ttf") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }()
}

/// Shared verbatim by the product popup and the isolated native observation host.
/// All input is read-only. No daemon, connection or dispatcher is owned by this view.
struct AttentionContextPanel: View {
    let snapshot: AttentionContextSnapshot
    var onSelect: (() -> Void)? = nil
    @State private var selection = AttentionContextSelection()

    private let bodyFont = Font.custom("IBMPlexSansKR-Regular", size: 12)
    private let titleFont = Font.custom("IBMPlexSansKR-Bold", size: 15)
    private let monoFont = Font.custom("JetBrainsMono-Regular", size: 10)

    init(snapshot: AttentionContextSnapshot, onSelect: (() -> Void)? = nil) {
        _ = AttentionContextFonts.register
        self.snapshot = snapshot
        self.onSelect = onSelect
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("ATTENTION / CONTEXT").font(monoFont)
                Spacer(minLength: 8)
                Text("실험 · 읽기 전용").font(bodyFont)
            }
            .foregroundStyle(DesignTokens.Tide.s300)

            VStack(alignment: .leading, spacing: 5) {
                Label(statusTitle, systemImage: selection.connected ? "circle.inset.filled" : "wifi.slash")
                    .font(titleFont)
                    .foregroundStyle(selection.connected && selection.awaiting.isEmpty ? DesignTokens.Kelp.s300 : DesignTokens.UI.attn)
                Text(selection.connected ? "선택한 맥락은 새 요청이 와도 바뀌지 않습니다." : "현재 상태를 확인할 수 없습니다. 마지막 관측만 남겨둡니다.")
                    .font(bodyFont)
                if let date = selection.receivedAt {
                    Text("관측 데이터 수신: \(date.formatted(date: .omitted, time: .standard))")
                        .font(bodyFont).foregroundStyle(DesignTokens.Tide.s300)
                }
            }

            if !selection.awaiting.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Text(selection.connected ? "응답이 필요한 세션" : "마지막으로 관측한 대기").font(bodyFont)
                    ForEach(selection.awaiting) { row in
                        Button { select(row.id) } label: {
                            HStack {
                                Text(row.title).lineLimit(1)
                                Spacer(minLength: 6)
                                Text(row.agentType ?? "Unknown agent").lineLimit(1)
                                Image(systemName: "arrow.right")
                            }
                            .font(bodyFont).padding(8)
                            .background(DesignTokens.UI.attn.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
                        }
                        .buttonStyle(.plain)
                        .help(row.id)
                    }
                }
                .foregroundStyle(DesignTokens.UI.attn)
            }

            if let row = selection.selected {
                detail(row)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("필요할 때 맥락을 펼쳐보세요.").font(titleFont)
                    Text("아래 세션을 선택해 관측된 활동과 요청을 확인합니다. 선택은 이 패널 안에서만 바뀝니다.")
                        .font(bodyFont).foregroundStyle(DesignTokens.Tide.s300)
                }
                .padding(.vertical, 10)
            }

            Divider().overlay(DesignTokens.Ink.s500)
            Text("세션 \(selection.rows.count) · 고정 순서").font(bodyFont)
            ForEach(selection.rows) { row in
                Button { select(row.id) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(row.title).font(titleFont).lineLimit(1)
                            Spacer(minLength: 4)
                            if selection.selectedID == row.id { Image(systemName: "pin.fill") }
                        }
                        Text("\(row.agentType ?? "Unknown agent") · \(row.stateLabel)").font(bodyFont)
                        Text(row.id).font(monoFont).lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(DesignTokens.Tide.s300)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(selection.selectedID == row.id ? DesignTokens.Ink.s700 : DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(row.title), \(row.agentType ?? "Unknown agent"), \(row.id), \(row.stateLabel)")
            }
            Text("새 승인·전송 동작, 자동 알림, 사용 기록 수집은 없습니다.")
                .font(bodyFont).foregroundStyle(DesignTokens.Tide.s300)
        }
        .padding(14)
        .foregroundStyle(DesignTokens.Tide.s50)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.Ink.s900)
        .onAppear { selection.ingest(snapshot) }
        .onChange(of: snapshot) { _, value in selection.ingest(value) }
    }

    private var statusTitle: String {
        if !selection.connected { return selection.hasSnapshot ? "연결 끊김 · 마지막 관측" : "세션 데이터 기다리는 중" }
        return selection.awaiting.isEmpty ? "관측된 응답 요청 없음" : "\(selection.awaiting.count)개 세션에 응답 필요"
    }

    private func select(_ id: String) {
        selection.select(id)
        onSelect?()
    }

    private func detail(_ row: AttentionContextRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Text(row.title).font(titleFont)
                Spacer(minLength: 8)
                Button("선택 해제") { selection.clearSelection() }.font(bodyFont).buttonStyle(.plain)
            }
            Text(row.id).font(monoFont).textSelection(.enabled)
            Text(selection.selectionIsCurrent ? row.stateLabel : "현재 목록에서 확인되지 않음 · 마지막 맥락")
                .font(bodyFont)
                .foregroundStyle(row.needsAttention || !selection.selectionIsCurrent ? DesignTokens.UI.attn : DesignTokens.Tide.s300)
            if row.needsAttention, let question = row.question, !question.isEmpty {
                Text(question).font(titleFont).textSelection(.enabled)
                if let detail = row.questionDetail, !detail.isEmpty {
                    Text(detail).font(bodyFont).textSelection(.enabled)
                }
            }
            if let activity = row.activity, !activity.isEmpty {
                Text("관측된 활동").font(bodyFont).foregroundStyle(DesignTokens.Tide.s300)
                Text(activity).font(bodyFont).textSelection(.enabled)
            } else {
                Text("이 세션의 활동 요약은 아직 전달되지 않았습니다.")
                    .font(bodyFont).foregroundStyle(DesignTokens.Tide.s300)
            }
            Text("출처: 데몬의 세션 목록. 개별 훅의 출처·만료 시각은 이 데이터만으로 확정하지 않습니다.")
                .font(bodyFont).foregroundStyle(DesignTokens.Tide.s300)
            Text("응답은 원래 작업 화면에서 확인하세요. 하네스가 응답 가능으로 보고해도 이 실험 패널은 읽기 전용입니다.")
                .font(bodyFont)
            Text("대기 상태나 활동 보고는 검증된 작업 완료를 뜻하지 않습니다.")
                .font(bodyFont).foregroundStyle(DesignTokens.Tide.s300)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 10))
    }
}
#endif
