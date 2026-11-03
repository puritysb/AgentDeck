package dev.agentdeck.net

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Real handshakes, parsed frames and the production retry path, without mDNS
 * or a Compose remount. Only coroutine time is advanced by the fixture. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class BridgeConnectionRecoveryTest {
    @Test fun `replacement owner recovers after retry exhaustion without discovery`() {
        Fixture().use { f ->
            f.exhaust()
            assertEquals(f.server.url, f.connection.selectedUrl)
            f.server.approved = true
            val requests = f.server.requests.get()
            f.clock.advanceTimeBy(PairingCodeRules.CLIENT_RECONNECT_COOLDOWN_MS - 1)
            f.clock.runCurrent()
            assertEquals(requests, f.server.requests.get())
            f.clock.advanceTimeBy(1)
            f.await { f.connection.status.value == ConnectionStatus.CONNECTED }
            assertEquals(requests + 1, f.server.requests.get())
            assertEquals(f.server.url, f.connection.url.value)
        }
    }

    @Test fun `explicit disconnect retires queued recovery`() {
        Fixture().use { f ->
            f.exhaust()
            f.connection.disconnect()
            f.server.approved = true
            val requests = f.server.requests.get()
            f.clock.advanceTimeBy(PairingCodeRules.CLIENT_RECONNECT_COOLDOWN_MS)
            f.clock.runCurrent()
            assertEquals(requests, f.server.requests.get())
            assertNull(f.connection.selectedUrl)
            assertEquals(ConnectionStatus.DISCONNECTED, f.connection.status.value)
            assertTrue(f.connection.userStopped.value)
            assertFalse(AutoConnectRules.shouldProbeOnEntry(f.connection.status.value, f.connection.selectedUrl, f.connection.userStopped.value))
            f.connection.autoConnect(f.server.url)
            f.clock.runCurrent()
            assertEquals("Automatic saved-host recovery must also respect stop", requests, f.server.requests.get())
            f.connection.connect(f.server.url)
            f.await { f.connection.status.value == ConnectionStatus.CONNECTED }
            assertFalse(f.connection.userStopped.value)
        }
    }

    @Test fun `new selection fences the previous hosts recovery`() {
        Fixture().use { f ->
            f.exhaust()
            Peer().use { replacement ->
                replacement.approved = true
                val oldRequests = f.server.requests.get()
                f.connection.connect(replacement.url)
                f.await { f.connection.status.value == ConnectionStatus.CONNECTED }
                f.clock.advanceTimeBy(PairingCodeRules.CLIENT_RECONNECT_COOLDOWN_MS)
                f.clock.runCurrent()
                assertEquals(oldRequests, f.server.requests.get())
                assertEquals(replacement.url, f.connection.url.value)
                assertEquals(replacement.url, f.connection.selectedUrl)
            }
        }
    }

    @Test fun `temporary authentication refusal waits then recovers without a user retry`() {
        Fixture(401).use { f ->
            f.connection.connect(f.server.url)
            f.await { f.connection.unauthorizedEndpoints.value.isNotEmpty() }
            f.server.approved = true
            f.clock.advanceTimeBy(PairingCodeRules.CLIENT_RECONNECT_COOLDOWN_MS)
            f.await { f.connection.status.value == ConnectionStatus.CONNECTED }
            assertEquals(2, f.server.requests.get())
        }
    }

    private class Fixture(code: Int = 503) : AutoCloseable {
        val server = Peer(code)
        val clock = TestCoroutineScheduler()
        private val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(clock))
        val connection = BridgeConnection(scope) { clock.currentTime }

        fun await(predicate: () -> Boolean) {
            val deadline = System.nanoTime() + 5_000_000_000L
            while (!predicate() && System.nanoTime() < deadline) {
                clock.runCurrent()
                Thread.sleep(5)
            }
            clock.runCurrent()
            assertTrue("Timed out waiting for connection state", predicate())
        }

        fun exhaust() {
            connection.connect(server.url)
            // IPv6 loopback exercises the selected-network-host branch rather
            // than the special localhost/ADB budget, using no LAN or devices.
            for (attempt in 1..6) {
                await { server.requests.get() >= attempt && connection.status.value == ConnectionStatus.DISCONNECTED }
                clock.runCurrent()
                if (attempt < 6) {
                    clock.advanceTimeBy(8_000)
                    clock.runCurrent()
                }
            }
            await { connection.url.value == null }
            assertEquals(6, server.requests.get())
        }

        override fun close() {
            connection.disconnect()
            scope.cancel()
            server.close()
        }
    }

    private class Peer(private val code: Int = 503) : AutoCloseable {
        private val listener = ServerSocket(0, 8, InetAddress.getByName("::1"))
        private val peers = CopyOnWriteArrayList<Socket>()
        val url = "ws://[::1]:${listener.localPort}"
        val requests = AtomicInteger()
        @Volatile var approved = false
        private val worker = thread(isDaemon = true) {
            while (!listener.isClosed) {
                val peer = runCatching { listener.accept() }.getOrNull() ?: break
                peers += peer
                runCatching {
                    peer.soTimeout = 3_000
                    val reader = peer.getInputStream().bufferedReader()
                    val headers = generateSequence { reader.readLine() }.takeWhile { it.isNotEmpty() }.toList()
                    requests.incrementAndGet()
                    val output = peer.getOutputStream()
                    if (!approved) {
                        output.write("HTTP/1.1 $code Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        output.flush()
                        peer.close()
                    } else {
                        val key = headers.first { it.startsWith("Sec-WebSocket-Key:", true) }.substringAfter(':').trim()
                        val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
                        output.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                        val frame = """{"type":"connection","status":"connected"}""".toByteArray()
                        output.write(byteArrayOf(0x81.toByte(), frame.size.toByte()) + frame)
                        output.flush()
                    }
                }
            }
        }
        override fun close() {
            listener.close()
            peers.forEach { runCatching { it.close() } }
            worker.join(1_000)
        }
    }
}
