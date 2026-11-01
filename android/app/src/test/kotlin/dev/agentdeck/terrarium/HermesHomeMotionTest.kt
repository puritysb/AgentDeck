package dev.agentdeck.terrarium

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs

class HermesHomeMotionTest {
    private fun tick(m: HermesHomeMotion, active: Boolean, seconds: Float, step: Float = 1f/60f) {
        repeat((seconds/step).toInt()) { m.step(step,active,false,0f,1f,.8f,1f,1.6f) }
    }
    @Test fun `lid clears head before emergence and swimming`() {
        val m=HermesHomeMotion()
        tick(m,true,.8f)
        assertTrue(m.shellOpen > 0f); assertEquals(0f,m.emergence,0f); assertEquals(1f,m.y,.0001f)
        tick(m,true,4f)
        assertEquals(1f,m.shellOpen,0f);assertEquals(1f,m.emergence,0f);assertTrue(m.y>1.3f)
    }
    @Test fun `return lands before tucking and lid closes last`() {
        val m=HermesHomeMotion();tick(m,true,9f)
        var sawTuck=false;var sawClose=false
        repeat(1800) {
            m.step(1f/60f,false,false,0f,1f,.8f,1f,1.6f)
            if (m.emergence in .01f.. .99f) {
                sawTuck=true;assertEquals(1f,m.shellOpen,.001f)
                assertTrue(abs(m.y-1f)<.05f)
            }
            if(m.shellOpen<.99f) {sawClose=true;assertEquals(0f,m.emergence,0f)}
        }
        assertTrue(sawTuck);assertTrue(sawClose);assertFalse(m.visible);assertEquals(0f,m.shellOpen,0f)
    }
    @Test fun `work resuming during return safely reopens`() {
        val m=HermesHomeMotion();tick(m,true,6f);tick(m,false,3f);tick(m,true,6f)
        assertTrue(m.visible);assertEquals(1f,m.shellOpen,0f);assertEquals(1f,m.emergence,0f)
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
