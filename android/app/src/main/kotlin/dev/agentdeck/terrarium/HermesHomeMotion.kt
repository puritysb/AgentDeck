package dev.agentdeck.terrarium

import kotlin.math.*

/** Continuous per-session motion. Clock suspension freezes motion; reduced motion resolves the live pose. */
internal class HermesHomeMotion(private val offset: Float = 0f) {
    var shellOpen = 0f; private set
    var emergence = 0f; private set
    var x = 0f; private set
    var y = 0f; private set
    var z = 0f; private set
    var vx = 0f; private set
    var vy = 0f; private set
    var vz = 0f; private set
    var elapsed = 0f; private set
    private var initialized = false
    val blink: Float get() {
        val t=(elapsed+offset)%TerrariumRules.HERMES_HOME_BLINK_PERIOD
        val close=TerrariumRules.HERMES_HOME_BLINK_CLOSE;val hold=TerrariumRules.HERMES_HOME_BLINK_HOLD
        return if(t<close) max(0f,1f-t/close) else if(t<close+hold) 0f else min(1f,(t-close-hold)/TerrariumRules.HERMES_HOME_BLINK_OPEN)
    }
    val visible get() = emergence > .02f
    val yaw get() = (atan2(vx, .45f + abs(vz)) * .8f).coerceIn(-.55f, .55f)
    val roll get() = (-vx * 1.8f).coerceIn(-.85f, .85f)
    val pitch get() = (-vz * .6f - vy * .4f).coerceIn(-.3f, .3f)

    fun step(delta: Float, active: Boolean, waiting: Boolean, homeX: Float, homeY: Float,
             homeZ: Float, size: Float, aspect: Float, animate: Boolean = true, berthX: Float = homeX, berthY: Float = homeY, berthZ: Float = homeZ) {
        if (!initialized) { x = homeX; y = homeY; z = homeZ; initialized = true }
        if (!animate) {
            shellOpen = if (active) 1f else 0f; emergence = shellOpen
            x = if(active) berthX else homeX; y = (if(active) berthY else homeY) + if (active) size * TerrariumRules.HERMES_HOME_SWIM_LIFT else 0f
            z = if(active) berthZ else homeZ; vx = 0f; vy = 0f; vz = 0f
            return
        }
        val dt = if (delta.isFinite()) delta.coerceIn(0f, .05f) else 0f
        if (dt == 0f) return
        elapsed += dt
        val distance = sqrt((x-homeX).pow(2)+(y-homeY).pow(2)+(z-homeZ).pow(2))
        val speed = sqrt(vx*vx+vy*vy+vz*vz)
        if (active) {
            shellOpen = min(1f, shellOpen + dt * TerrariumRules.HERMES_HOME_OPEN_RATE)
            if (shellOpen >= TerrariumRules.HERMES_HOME_LID_CLEARANCE)
                emergence = min(1f, emergence + dt * TerrariumRules.HERMES_HOME_EMERGE_RATE)
        } else if (distance < max(.01f, size * TerrariumRules.HERMES_HOME_SETTLE_DISTANCE) && speed < TerrariumRules.HERMES_HOME_SETTLE_SPEED) {
            emergence = max(0f, emergence - dt * TerrariumRules.HERMES_HOME_EMERGE_RATE)
            if (emergence == 0f) shellOpen = max(0f, shellOpen - dt * TerrariumRules.HERMES_HOME_CLOSE_RATE)
        }
        val departure = ((emergence-TerrariumRules.HERMES_HOME_DEPARTURE_START)/(1f-TerrariumRules.HERMES_HOME_DEPARTURE_START)).coerceIn(0f,1f)
        val swim = if (active) departure*departure*(3f-2f*departure) else 0f
        val t = elapsed*TerrariumRules.HERMES_HOME_TRAVEL_RATE+offset
        val radius = size*(TerrariumRules.HERMES_HOME_SWIM_RADIUS+if (waiting) 0f else TerrariumRules.HERMES_HOME_WORK_RADIUS)*(if(waiting) .15f else 1f)*(if(berthX!=homeX || berthY!=homeY || berthZ!=homeZ) TerrariumRules.HERMES_HOME_BERTH_TRAVEL_SCALE else 1f)
        val limit = min(3.65f,max(.9f,aspect*3f))-size*.35f
        var outsideX=(berthX+sin(t)*radius).coerceIn(-limit,limit)
        if(berthX!=homeX && abs(berthX)>.001f) {
            val inward=min(limit,max(0f,abs(berthX)-size*TerrariumRules.HERMES_HOME_BERTH_INWARD_TRAVEL))
            outsideX=if(berthX<0f) min(-inward,outsideX) else max(inward,outsideX)
        }
        val tx = homeX+(outsideX-homeX)*swim
        val ty = homeY+(berthY-homeY+size*TerrariumRules.HERMES_HOME_SWIM_LIFT+sin(t*1.37f)*radius*.16f+sin(elapsed*1.7f+offset)*size*.07f)*swim
        val tz = homeZ+(berthZ-homeZ+sin(t*.83f)*radius*.7f)*swim
        val blend = 1f-exp(-dt*2.5f)
        vx += ((tx-x)*1.5f-vx)*blend; vy += ((ty-y)*1.5f-vy)*blend; vz += ((tz-z)*1.5f-vz)*blend
        val nextSpeed = sqrt(vx*vx+vy*vy+vz*vz)
        val maximum = max(.2f,size*(if(waiting) .5f else .8f))
        if (nextSpeed > maximum) { vx *= maximum/nextSpeed; vy *= maximum/nextSpeed; vz *= maximum/nextSpeed }
        x += vx*dt; y += vy*dt; z += vz*dt
        if (!active && distance < .002f && speed < .005f) { x=homeX; y=homeY; z=homeZ; vx=0f; vy=0f; vz=0f }
    }
}

/** One entrance lease; out-of-home residents keep their berth until the mouth is free. */
internal class SharedShellTraffic {
    data class Request(val id:String,val wantsOut:Boolean,val emergence:Float,val distance:Float)
    var owner:String?=null;private set
    fun update(requests:List<Request>) {
        fun needs(r:Request)=if(r.wantsOut) r.emergence<1f || r.distance<TerrariumRules.HERMES_HOME_MOUTH_CLEARANCE else r.emergence>0f
        if(requests.none { it.id==owner && needs(it) }) owner=null
        if(owner==null) owner=requests.filter(::needs).sortedWith(compareBy<Request>{it.wantsOut}.thenBy{it.id}).firstOrNull()?.id
    }
    fun active(id:String,wantsOut:Boolean,emergence:Float)=if(wantsOut) emergence>0f || owner==id else emergence>0f && owner!=id
}
