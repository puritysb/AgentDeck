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
    private var previousActive=false
    private var clearingMouth=true
    private var frontLaneReached=false
    private var depthLaneReached=false
    private var returnDepthReached=false
    private var centerLaneReached=false
    val blink: Float get() {
        val t=(elapsed+offset)%TerrariumRules.HERMES_HOME_BLINK_PERIOD
        val close=TerrariumRules.HERMES_HOME_BLINK_CLOSE;val hold=TerrariumRules.HERMES_HOME_BLINK_HOLD
        return if(t<close) max(0f,1f-t/close) else if(t<close+hold) 0f else min(1f,(t-close-hold)/TerrariumRules.HERMES_HOME_BLINK_OPEN)
    }
    val dockScale: Float get() {
        val p=emergence*emergence*(3f-2f*emergence)
        return TerrariumRules.HERMES_HOME_COMPACT_SCALE+(1f-TerrariumRules.HERMES_HOME_COMPACT_SCALE)*p
    }
    fun mouthY(homeY:Float,size:Float)=homeY+size*TerrariumRules.HERMES_HOME_MOUTH_LIFT
    val mouthZ get()=TerrariumRules.HERMES_HOME_SHARED_Z+TerrariumRules.HERMES_HOME_MOUTH_FRONT
    val visible get() = emergence > .02f
    val yaw get() = (atan2(vx, .45f + abs(vz)) * .8f).coerceIn(-.55f, .55f)
    val navigatingDoorway get()=emergence<1f || clearingMouth || !depthLaneReached || !previousActive
    val roll get() = if(navigatingDoorway) 0f else (-vx * 1.8f).coerceIn(-.85f, .85f)
    val pitch get() = if(navigatingDoorway) 0f else (-vz * .6f - vy * .4f).coerceIn(-.3f, .3f)

    fun step(delta: Float, active: Boolean, waiting: Boolean, homeX: Float, homeY: Float,
             homeZ: Float, size: Float, aspect: Float, animate: Boolean = true, berthX: Float = homeX, berthY: Float = homeY, berthZ: Float = homeZ, grounded: Boolean = false, aperture: Float = 1f, effort: Float = if(waiting) 0f else 1f) {
        if (!initialized) { x = homeX; y = homeY; z = homeZ; initialized = true }
        if (!animate) {
            shellOpen = if (active) 1f else 0f; emergence = shellOpen
            previousActive=active;centerLaneReached=active;depthLaneReached=active
            clearingMouth=!active;frontLaneReached=false;returnDepthReached=false
            x = if(active) berthX else homeX; y = (if(active) berthY else homeY) + if (active && !grounded) size * TerrariumRules.HERMES_HOME_SWIM_LIFT else 0f
            z = if(active) berthZ else homeZ; vx = 0f; vy = 0f; vz = 0f
            return
        }
        val dt = if (delta.isFinite()) delta.coerceIn(0f, .05f) else 0f
        if (dt == 0f) return
        if(active!=previousActive) {
            // Reverse the current leg rather than cutting across the house.
            if(emergence==1f) {
                if(active) {
                    val wasAtCenter=centerLaneReached
                    clearingMouth=frontLaneReached;depthLaneReached=!returnDepthReached
                    centerLaneReached=!wasAtCenter
                } else {
                    returnDepthReached=!depthLaneReached;frontLaneReached=clearingMouth
                    centerLaneReached=!centerLaneReached
                }
            } else {
                clearingMouth=true;frontLaneReached=false;depthLaneReached=false
                returnDepthReached=false;centerLaneReached=false
            }
            previousActive=active
        }
        elapsed += dt
        val mouthY=mouthY(homeY,size)
        val wasDocking=emergence<1f
        val distance = sqrt((x-homeX).pow(2)+(y-mouthY).pow(2)+(z-mouthZ).pow(2))
        val speed = sqrt(vx*vx+vy*vy+vz*vz)
        if (active) {
            shellOpen = min(1f, shellOpen + dt * TerrariumRules.HERMES_HOME_OPEN_RATE)
            if (min(shellOpen,aperture) >= TerrariumRules.HERMES_HOME_LID_CLEARANCE)
                emergence = min(1f, emergence + dt * TerrariumRules.HERMES_HOME_EMERGE_RATE)
        } else if (emergence<1f || (distance < max(.01f, size * TerrariumRules.HERMES_HOME_SETTLE_DISTANCE) && speed < TerrariumRules.HERMES_HOME_SETTLE_SPEED)) {
            if(emergence==0f || aperture>=TerrariumRules.HERMES_HOME_LID_CLEARANCE)
                emergence = max(0f, emergence - dt * TerrariumRules.HERMES_HOME_EMERGE_RATE)
            if (emergence == 0f) shellOpen = max(0f, shellOpen - dt * TerrariumRules.HERMES_HOME_CLOSE_RATE)
        }
        val t = elapsed*TerrariumRules.HERMES_HOME_TRAVEL_RATE+offset
        val radius = size*(TerrariumRules.HERMES_HOME_SWIM_RADIUS+if (waiting) 0f else TerrariumRules.HERMES_HOME_WORK_RADIUS)*(if(waiting) .15f else 1f)*(if(berthX!=homeX || berthY!=homeY || berthZ!=homeZ) TerrariumRules.HERMES_HOME_BERTH_TRAVEL_SCALE else 1f)
        val limit = min(3.65f,max(.9f,aspect*3f))-size*.35f
        var outsideX=(berthX+sin(t)*radius).coerceIn(-limit,limit)
        if(berthX!=homeX && abs(berthX)>.001f) {
            val inward=min(limit,max(0f,abs(berthX)-size*TerrariumRules.HERMES_HOME_BERTH_INWARD_TRAVEL))
            outsideX=if(berthX<0f) min(-inward,outsideX) else max(inward,outsideX)
        }
        var tx = if(!active) homeX else if(grounded) berthX+sin(t)*size*effort*TerrariumRules.NATIVE_ACTIVITY_GROUND_TRAVEL else outsideX
        var ty = if(!active) mouthY else if(grounded) berthY else berthY+size*TerrariumRules.HERMES_HOME_SWIM_LIFT+sin(t*1.37f)*radius*.16f+sin(elapsed*1.7f+offset)*size*.07f
        var tz = if(!active) mouthZ else if(grounded) berthZ else berthZ+sin(t*.83f)*radius*.7f
        val laneY=homeY+size*TerrariumRules.HERMES_HOME_LANE_LIFT
        fun settled(xTarget:Float,yTarget:Float,zTarget:Float)=sqrt((x-xTarget).pow(2)+(y-yTarget).pow(2)+(z-zTarget).pow(2))<max(.01f,size*TerrariumRules.HERMES_HOME_LANE_DISTANCE) && speed<TerrariumRules.HERMES_HOME_LANE_SPEED
        if(active) {
            if(!centerLaneReached) {
                if(settled(homeX,laneY,mouthZ)) centerLaneReached=true
                tx=homeX;ty=laneY;tz=mouthZ
            } else if(clearingMouth) {
                if(settled(berthX,laneY,mouthZ)) clearingMouth=false
                tx=berthX;ty=laneY;tz=mouthZ
            } else if(!depthLaneReached) {
                if(settled(berthX,laneY,berthZ)) depthLaneReached=true
                tx=berthX;ty=laneY;tz=berthZ
            }
        } else {
            if(!returnDepthReached) {
                if(settled(berthX,laneY,berthZ)) returnDepthReached=true
                tx=berthX;ty=laneY;tz=berthZ
            } else if(!frontLaneReached) {
                if(settled(berthX,laneY,mouthZ)) frontLaneReached=true
                tx=berthX;ty=laneY;tz=mouthZ
            } else if(!centerLaneReached) {
                if(settled(homeX,laneY,mouthZ)) centerLaneReached=true
                tx=homeX;ty=laneY;tz=mouthZ
            } else { tx=homeX;ty=mouthY;tz=mouthZ }
        }
        // Reversible entry over the lip. Never displace a full-size tail through
        // the sealed lower valve; model compaction keeps the feet planted.
        if(emergence<1f || wasDocking) {
            val p=emergence*emergence*(3f-2f*emergence)
            val nx=homeX;val ny=homeY+(mouthY-homeY)*p;val nz=homeZ+(mouthZ-homeZ)*p
            vx=(nx-x)/dt;vy=(ny-y)/dt;vz=(nz-z)/dt
            x=nx;y=ny;z=nz
            return
        }
        val blend = 1f-exp(-dt*2.5f)
        vx += ((tx-x)*1.5f-vx)*blend; vy += ((ty-y)*1.5f-vy)*blend; vz += ((tz-z)*1.5f-vz)*blend
        val nextSpeed = sqrt(vx*vx+vy*vy+vz*vz)
        val maximum = max(.2f,size*(if(waiting) .5f else .8f))
        if (nextSpeed > maximum) { vx *= maximum/nextSpeed; vy *= maximum/nextSpeed; vz *= maximum/nextSpeed }
        x += vx*dt; y += vy*dt; z += vz*dt
        if (!active && distance < .002f && speed < .005f) { x=homeX; y=mouthY; z=mouthZ; vx=0f; vy=0f; vz=0f }
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
