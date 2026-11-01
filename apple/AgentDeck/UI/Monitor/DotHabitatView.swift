import SwiftUI

/// A pearl in the habitat, with the same shell clock and name-tag treatment as its neighbours.
struct DotHabitatView: View {
    let snapshot: DotSurfaceSnapshot
    var animationPaused = false
    var labelsVisible = true
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var swim = HermesSwim(id: "habitat:dot", position: [Float((DotHabitatRules.homeX-0.5)*8), Float((0.82-DotHabitatRules.homeY)*7), 0])
    @State private var showReport = false
    private var home: SIMD3<Float> { [Float((DotHabitatRules.homeX-0.5)*8),Float((0.82-DotHabitatRules.homeY)*7),0] }
    private var playbackID: String { "\(snapshot.configured)|\(snapshot.hosting)|\(snapshot.reportedAt ?? 0)|\(snapshot.phase(at: Int(Date().timeIntervalSince1970*1000)))|\(scenePhase == .active)|\(animationPaused)|\(reduceMotion)" }
    var body: some View {
        GeometryReader { geo in
            let side = min(DotHabitatRules.maxSize,max(DotHabitatRules.minSize,geo.size.height*DotHabitatRules.sizeFraction))
            let x = CGFloat(0.5+swim.position.x/8)*geo.size.width
            let y = CGFloat(0.82-swim.position.y/7)*geo.size.height
            let hx = geo.size.width*DotHabitatRules.homeX
            let hy = geo.size.height*DotHabitatRules.homeY
            let phase = snapshot.phase(at: Int(Date().timeIntervalSince1970*1000))
            ZStack {
                Canvas { context, size in
                    if swim.emergence > 0.02 {
                        let r=side/2, py=y+CGFloat(1-swim.emergence)*r
                        var pearl=context;pearl.opacity=Double(swim.emergence)
                        pearl.fill(Path(ellipseIn:CGRect(x:x-r,y:py-r,width:side,height:side)),
                            with:.radialGradient(Gradient(colors:[DesignTokens.Tide.s50,DesignTokens.Tide.s100,DesignTokens.Tide.s300]),center:CGPoint(x:x-r*0.3,y:py-r*0.4),startRadius:0,endRadius:r*1.6))
                        for eye:CGFloat in [-0.3,0.3] {
                            let rect=CGRect(x:x+eye*r-r*0.05,y:py-r*0.12,width:r*0.1,height:r*0.32)
                            pearl.fill(Path(roundedRect:rect,cornerRadius:r*0.05),with:.color(DesignTokens.Ink.s900))
                        }
                    }
                    if labelsVisible && snapshot.configured {
                        drawTerrariumNameTag(context:&context,name:"Dot",cx:x,bodyTopY:y-side/2,
                            bodyMetric:terrariumNameTagMetric(canvasWidth:size.width,scale:1),backgroundColor:TerrariumColors.deepSea,
                            rank:phase==3 || phase==5 ? .awaiting : phase==2 ? .working : .idle)
                    }
                }.allowsHitTesting(false)
                if swim.emergence > 0.8, let appearance=snapshot.appearance {
                    DotCharacterImage(appearance:appearance).frame(width:side*0.75,height:side*0.75).clipShape(Circle()).position(x:x,y:y).allowsHitTesting(false)
                }
                Button { showReport=true } label: { Color.clear.frame(width:side*2,height:side*2).contentShape(Rectangle()) }
                    .buttonStyle(.plain).position(x:swim.emergence>0.02 ? x : hx,y:swim.emergence>0.02 ? y : hy)
                    .accessibilityLabel("Dot. \(DotAppearanceRules.labels[phase]). Open report.")
            }
        }
        .task(id:playbackID) {
            let enabled=scenePhase == .active && !animationPaused && !reduceMotion
            var previous=ProcessInfo.processInfo.systemUptime
            repeat {
                let time=ProcessInfo.processInfo.systemUptime
                let now=Int(Date().timeIntervalSince1970*1000),code=snapshot.phase(at:Int(Date().timeIntervalSince1970*1000))
                swim.step(enabled ? Float(time-previous) : 0,home:[(TerrariumRules.hermesHomeCanvasX-0.5)*8,(0.82-TerrariumRules.hermesHomeCanvasY)*7,0],size:0.5,
                    activity:code==2 ? .working : code==3 ? .waiting : code==5 ? .error : .idle,
                    neighbours:[],aspect:1.6,shellActive:snapshot.inhabitsHabitat(at:now),berth:home)
                previous=time
                if !enabled { break }
                try? await Task.sleep(for:.seconds(1.0/30))
            } while !Task.isCancelled
        }
        .sheet(isPresented:$showReport) {
            VStack { HStack { Text("Dot report").font(.headline);Spacer();Button("Done") { showReport=false } };DotSurfaceView(snapshot:snapshot) }.padding().frame(maxWidth:580)
        }
    }
}
