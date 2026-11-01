package dev.agentdeck.terrarium

import org.junit.Assert.*
import org.junit.Test

class HermesHomeMotionTest {
    private fun tick(m: HermesHomeMotion, active: Boolean, seconds: Float, step: Float = 1f/60f) {
        repeat((seconds/step).toInt()) { m.step(step,active,false,0f,1f,.8f,1f,1.6f) }
    }
    @Test fun `shared entrance serializes departures and returns without blocking outside peers`() {
        val traffic=SharedShellTraffic()
        val a=SharedShellTraffic.Request("a",true,0f,0f)
        val b=a.copy(id="b")
        traffic.update(listOf(b,a));assertEquals("a",traffic.owner)
        assertTrue(traffic.active("a",true,0f));assertFalse(traffic.active("b",true,0f))
        traffic.update(listOf(a.copy(emergence=1f,distance=2f),b));assertEquals("b",traffic.owner)
        assertTrue(traffic.active("a",true,1f))
        traffic.update(listOf(a.copy(wantsOut=false,emergence=1f,distance=2f),b.copy(emergence=.5f)))
        assertEquals("b",traffic.owner);assertTrue(traffic.active("a",false,1f))
        traffic.update(listOf(a.copy(wantsOut=false,emergence=1f,distance=2f),b.copy(emergence=1f,distance=2f)))
        assertEquals("a",traffic.owner);assertFalse(traffic.active("a",false,1f))
        traffic.update(emptyList());assertNull(traffic.owner)
    }
    @Test fun `shared home departure reaches its assigned berth and returns to the same mouth`() {
        val m=HermesHomeMotion()
        repeat(1200) { m.step(1f/60f,true,true,0f,1f,.8f,1f,1.6f,berthX=2f) }
        assertTrue(m.x>1.5f)
        repeat(2400) { m.step(1f/60f,false,false,0f,1f,.8f,1f,1.6f,berthX=2f) }
        assertEquals(0f,m.x,.01f);assertEquals(0f,m.emergence,0f)
    }
    @Test fun `lid clears head before emergence and swimming`() {
        val m=HermesHomeMotion()
        tick(m,true,.8f)
        assertTrue(m.shellOpen > 0f); assertEquals(0f,m.emergence,0f); assertEquals(1f,m.y,.0001f)
        tick(m,true,4f)
        assertEquals(1f,m.shellOpen,0f);assertEquals(1f,m.emergence,0f);assertTrue(m.z>.8f)
    }
    @Test fun `return uses front lip and compacts above floor before lid closes`() {
        val m=HermesHomeMotion();tick(m,true,9f)
        var sawTuck=false;var sawClose=false
        repeat(1800) {
            m.step(1f/60f,false,false,0f,1f,.8f,1f,1.6f)
            if (m.emergence in .01f.. .99f) {
                sawTuck=true;assertEquals(1f,m.shellOpen,.001f)
                assertTrue(m.y>=1f);assertTrue(m.z>=.8f)
                // A compacted model keeps its lowest point above the basin.
                val foot=.7f
                assertTrue(m.y-foot*(1f-m.dockScale)-foot*m.dockScale>=.3f-.0001f)
            }
            if(m.shellOpen<.99f) {sawClose=true;assertEquals(0f,m.emergence,0f)}
        }
        assertTrue(sawTuck);assertTrue(sawClose);assertFalse(m.visible);assertEquals(0f,m.shellOpen,0f)
    }
    @Test fun `grounded gateway remains outside while idle and retires through the same mouth`() {
        val m=HermesHomeMotion()
        repeat(1800) { m.step(1f/60f,true,false,0f,.6f,1.6f,.75f,1.6f,berthX=2f,berthY=.8f,berthZ=1f,grounded=true) }
        assertEquals(1f,m.emergence,0f);assertEquals(.8f,m.y,.01f)
        repeat(1800) { m.step(1f/60f,false,false,0f,.6f,1.6f,.75f,1.6f,berthX=2f,berthY=.8f,berthZ=1f,grounded=true) }
        assertFalse(m.visible);assertEquals(0f,m.shellOpen,0f)
    }
    @Test fun `return goes around shell front before aligning with its mouth`() {
        val m=HermesHomeMotion()
        repeat(1800) { m.step(1f/60f,true,true,0f,1f,1.6f,.8f,1.6f,berthX=2f,berthY=1.5f,berthZ=1f) }
        var sawFront=false;var sawDock=false
        repeat(2400) {
            m.step(1f/60f,false,false,0f,1f,1.6f,.8f,1.6f,berthX=2f,berthY=1.5f,berthZ=1f)
            if(m.emergence==1f && m.x<1f) { sawFront=true;assertEquals(m.mouthZ,m.z,.05f) }
            if(m.emergence>0f && m.emergence<1f) { sawDock=true;assertEquals(0f,m.x,.001f);assertTrue(m.y>=1f) }
        }
        assertTrue(sawFront);assertTrue(sawDock)
    }
    @Test fun `closed shared lid holds the returning body outside until it clears`() {
        val m=HermesHomeMotion();tick(m,true,12f)
        repeat(1800) { m.step(1f/60f,false,false,0f,1f,.8f,1f,1.6f,aperture=0f) }
        assertEquals(1f,m.emergence,0f);assertTrue(m.visible)
        assertEquals(m.mouthZ,m.z,.01f)
        repeat(900) { m.step(1f/60f,false,false,0f,1f,.8f,1f,1.6f,aperture=1f) }
        assertFalse(m.visible)
    }
    @Test fun `work resuming during return safely reopens`() {
        val m=HermesHomeMotion();tick(m,true,6f);tick(m,false,3f);tick(m,true,6f)
        assertTrue(m.visible);assertEquals(1f,m.shellOpen,0f);assertEquals(1f,m.emergence,0f)
    }
    @Test fun `short turns and resumed work reverse the current leg without corner cuts`() {
        for(cut in 2..18 step 2) {
            val m=HermesHomeMotion()
            repeat(4800) { frame ->
                val t=frame/60f
                val active=t<cut || (t>=cut+1.5f && t<cut+3.5f)
                m.step(1f/60f,active,false,0f,1f,1.6f,.8f,1.6f,berthX=2f,berthY=1.5f,berthZ=1.3f)
                if(m.emergence==1f && m.x>.2f && m.x<1.7f) assertEquals(m.mouthZ,m.z,.15f)
            }
            assertEquals(0f,m.emergence,0f)
        }
    }
    @Test fun `reduced motion during departure resumes at its resolved berth`() {
        val m=HermesHomeMotion()
        repeat(180) { m.step(1f/60f,true,false,0f,1f,1.6f,.8f,1.6f,berthX=2f,berthY=1.5f,berthZ=1.3f) }
        m.step(0f,true,false,0f,1f,1.6f,.8f,1.6f,false,berthX=2f,berthY=1.5f,berthZ=1.3f)
        repeat(600) {
            m.step(1f/60f,true,false,0f,1f,1.6f,.8f,1.6f,berthX=2f,berthY=1.5f,berthZ=1.3f)
            assertTrue(m.x>1.7f)
        }
    }
    @Test fun `frame rate changes preserve trajectory and suspension freezes it`() {
        val a=HermesHomeMotion(.8f);val b=HermesHomeMotion(.8f)
        tick(a,true,12f,1f/30f);tick(b,true,12f,1f/60f)
        assertEquals(a.x,b.x,.045f);assertEquals(a.y,b.y,.045f)
        val x=a.x;val open=a.shellOpen
        a.step(Float.NaN,false,false,0f,1f,.8f,1f,1.6f)
        assertEquals(x,a.x,0f);assertEquals(open,a.shellOpen,0f)
    }
    @Test fun `reduced motion resolves live shell state without travelling`() {
        val m=HermesHomeMotion()
        m.step(0f,true,true,0f,1f,.8f,1f,1.6f,false)
        assertEquals(1f,m.shellOpen,0f);assertTrue(m.visible);assertEquals(0f,m.vx,0f)
        m.step(0f,false,false,0f,1f,.8f,1f,1.6f,false)
        assertEquals(0f,m.shellOpen,0f);assertFalse(m.visible);assertEquals(1f,m.y,0f)
    }
}
