import SwiftUI

/// Canvas companion to the Blender model, for the standard dashboard/fallback.
final class HermesCreature: Creature {
    static var homeElevation: Float { (0.82 - TerrariumRules.hermesHomeCanvasRestY) * 7 }
    let id: String
    var home: SIMD3<Float>
    var scale: Float
    private var swim: HermesSwim
    private var activity: HermesSwim.Activity = .idle
    private var title = "Hermes"
    var simulationPosition: SIMD2<Float> { [0.5 + swim.position.x / 8, 0.82 - swim.position.y / 7] }
    var currentX: Float { simulationPosition.x }
    var currentY: Float { simulationPosition.y }

    init(id: String, index: Int, count: Int) {
        self.id = id
        home = [Float(index - count / 2) * 0.9, Self.homeElevation, 0]
        scale = min(1, 3 / Float(max(1, count)))
        swim = .init(id: id, position: home)
    }
    func update(dt: Float, state: TerrariumState) {
        guard let item = state.hermesCreatures.first(where: { $0.id == id }) else { return }
        activity = item.activity
        title = item.projectName ?? "Hermes"
        swim.step(dt, home:[(TerrariumRules.hermesHomeCanvasX-0.5)*8,(0.82-TerrariumRules.hermesHomeCanvasY)*7,0],size:scale,activity:activity,neighbours:[],aspect:1.6,berth:home)
    }
    func draw(context: inout GraphicsContext, size: CGSize) {
        let x = CGFloat(currentX) * size.width, y = CGFloat(currentY) * size.height
        let r = min(size.width, size.height) * 0.053 * CGFloat(scale)
        var c = context
        c.opacity *= Double(swim.emergence)
        c.translateBy(x: x, y: y)
        c.rotate(by: .radians(Double(swim.roll)))
        func oval(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: Color) {
            c.fill(Path(ellipseIn: CGRect(x: x*r, y: y*r, width: w*r, height: h*r)), with: .color(color))
        }
        var tail = Path()
        let bend = CGFloat(swim.tail)
        tail.move(to: CGPoint(x: -0.19*r, y: 0.2*r))
        tail.addCurve(to: CGPoint(x: (0.65+bend)*r, y: 0.85*r),
                      control1: CGPoint(x: -0.5*r, y: 1.1*r), control2: CGPoint(x: 0.25*r, y: 1.0*r))
        tail.addLine(to: CGPoint(x: (0.42+bend)*r, y: 0.52*r))
        tail.addQuadCurve(to: CGPoint(x: 0.20*r, y: 0.20*r), control: CGPoint(x: 0.18*r, y: 0.8*r))
        tail.closeSubpath()
        c.fill(tail, with: .color(DesignTokens.Kelp.s500))
        oval(0.46+bend,0.55,0.40,0.14,DesignTokens.Kelp.s300)
        oval(0.48+bend,0.76,0.37,0.17,DesignTokens.Kelp.s300)
        let bodyContext=c
        c.scaleBy(x:CGFloat(TerrariumRules.hermesHomeHeadScale),y:CGFloat(TerrariumRules.hermesHomeHeadScale))
        oval(-0.67,-0.88,1.34,1.30,DesignTokens.Ink.s900)
        oval(-0.44,-0.65,0.88,0.87,DesignTokens.Tide.s50)
        oval(-0.52,-0.85,1.04,0.38,DesignTokens.Ink.s900)
        for side: CGFloat in [-1,1] {
            oval(side*0.50-0.10,-0.50,0.20,0.87,DesignTokens.Ink.s900)
            oval(side*0.17-0.033,-0.22,0.066,0.10*CGFloat(swim.blink),DesignTokens.Ink.s900)
            oval(side*0.30-0.07,0.3-CGFloat(swim.arm)*0.25,0.14,0.29,DesignTokens.Tide.s50)
        }
        oval(-0.04,-0.015,0.08,0.025,DesignTokens.Ink.s900)
        c=bodyContext
        c.opacity=1
        if activity == .working || activity == .waiting || activity == .error {
            let mark = activity == .working ? "···" : "!"
            c.draw(Text(mark).font(.system(size: r*0.55, weight: .bold))
                .foregroundStyle(activity == .working ? DesignTokens.Session.working : activity == .error ? DesignTokens.Session.error : DesignTokens.Session.awaiting),
                at: CGPoint(x: r*0.85, y: -r*0.3))
        }
        drawTerrariumNameTag(context: &context, name: title, cx: x, bodyTopY: y-r,
            bodyMetric: terrariumNameTagMetric(canvasWidth: size.width, scale: scale),
            backgroundColor: TerrariumColors.deepSea,
            rank: activity == .waiting || activity == .error ? .awaiting : activity == .working ? .working : .idle)
    }
}

/// Shared screen-space scallop. Its hinge stays at the assigned home.
enum ShellHome2D {
    static func draw(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, radius r: CGFloat, opening: Float) {
        var shell=context;shell.translateBy(x:cx,y:cy)
        let lid=CGFloat(0.25+opening*0.9)
        var valve=Path();valve.move(to:CGPoint(x:-r,y:0))
        valve.addCurve(to:CGPoint(x:r,y:0),control1:CGPoint(x:-r*1.5,y:-r*lid),control2:CGPoint(x:r*1.5,y:-r*lid))
        valve.addLine(to:CGPoint(x:r*0.2,y:r*0.3));valve.addLine(to:CGPoint(x:-r*0.2,y:r*0.3));valve.closeSubpath()
        shell.fill(valve,with:.color(DesignTokens.Tide.s100));shell.stroke(valve,with:.color(DesignTokens.Tide.s300),lineWidth:max(1,r*0.04))
        for i in -3...3 {
            var rib=Path();rib.move(to:CGPoint(x:CGFloat(i)*r*0.24,y:-r*lid*0.5));rib.addLine(to:CGPoint(x:CGFloat(i)*r*0.04,y:r*0.2))
            shell.stroke(rib,with:.color(DesignTokens.Tide.s300),lineWidth:max(1,r*0.025))
        }
        shell.fill(Path(ellipseIn:CGRect(x:-r*1.1,y:-r*0.08,width:r*2.2,height:r*0.48)),with:.color(DesignTokens.Tide.s200))
    }
}
