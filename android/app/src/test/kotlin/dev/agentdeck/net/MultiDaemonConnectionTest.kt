package dev.agentdeck.net

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

@RunWith(RobolectricTestRunner::class)
class MultiDaemonConnectionTest {
    @Test fun `HTTP 401 stops reconnecting and explicit retry reaches the selected host`() = refusal(401)
    @Test fun `WebSocket 4001 stops reconnecting and explicit retry reaches the selected host`() = refusal(4001)

    private fun refusal(code: Int) {
        RefusalServer(code).use { server ->
            val connection = BridgeConnection()
            try {
                connection.connect(server.url)
                await { connection.lastError.value?.startsWith("Approval required") == true }
                assertEquals(ConnectionStatus.DISCONNECTED, connection.status.value)
                assertFalse(connection.isReconnecting.value)
                assertEquals(server.url, connection.url.value)
                assertTrue(connection.lastError.value!!.contains("Devices › Pair Device"))
                Thread.sleep(1300)
                assertEquals(1, server.requests.get())
                server.approved = true
                connection.connect(server.url)
                await { connection.status.value == ConnectionStatus.CONNECTED }
                assertEquals(2, server.requests.get())
                assertEquals(server.url, connection.url.value)
                assertNull(connection.lastError.value)
            } finally { connection.disconnect() }
        }
    }

    @Test fun `late failure from replaced socket does not change selected host`() {
        RefusalServer(401, delayMs = 400).use { first ->
            RefusalServer(401).use { second ->
                val connection = BridgeConnection()
                try {
                    connection.connect(first.url)
                    await { first.requests.get() == 1 }
                    connection.connect(second.url)
                    await { connection.lastError.value?.contains("127.0.0.1:${second.port}") == true }
                    Thread.sleep(600)
                    assertEquals(second.url, connection.url.value)
                    assertTrue(connection.lastError.value!!.contains("127.0.0.1:${second.port}"))
                    assertEquals(1, second.requests.get())
                } finally { connection.disconnect() }
            }
        }
    }

    @Test fun `operator approval takes effect after holdoff without touching the reader`() {
        RefusalServer(401).use { server ->
            val connection = BridgeConnection()
            try {
                connection.connect(server.url)
                await { connection.lastError.value?.startsWith("Approval required") == true }
                server.approved = true
                await(35_000) { connection.status.value == ConnectionStatus.CONNECTED }
                assertEquals(2, server.requests.get())
            } finally { connection.disconnect() }
        }
    }

    private fun await(timeoutMs: Long = 8_000, condition: () -> Boolean) {
        val until = System.nanoTime() + timeoutMs * 1_000_000L
        while (!condition() && System.nanoTime() < until) Thread.sleep(10)
        assertTrue("condition timed out", condition())
    }

    private class RefusalServer(val code: Int, val delayMs: Long = 0) : AutoCloseable {
        private val server = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        val url = "ws://127.0.0.1:$port"
        val requests = AtomicInteger()
        @Volatile var approved = false
        private val worker = thread(isDaemon = true) {
            while (!server.isClosed) {
                try {
                    server.accept().use { socket ->
                        socket.soTimeout = 3000
                        val reader = socket.getInputStream().bufferedReader()
                        val lines = mutableListOf<String>()
                        while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break; lines.add(line) }
                        requests.incrementAndGet()
                        Thread.sleep(delayMs)
                        val out = socket.getOutputStream()
                        if (code == 401 && !approved) {
                            out.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                            out.flush()
                        } else {
                            val key = lines.first { it.startsWith("Sec-WebSocket-Key:", true) }.substringAfter(':').trim()
                            val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
                            out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                            if (approved) {
                                val payload = """{"type":"connection","status":"connected"}""".toByteArray()
                                out.write(byteArrayOf(0x81.toByte(), payload.size.toByte()))
                                out.write(payload)
                            } else {
                                out.write(byteArrayOf(0x88.toByte(), 2, 0x0f, 0xa1.toByte()))
                            }
                            out.flush()
                            if (approved) {
                                while (socket.getInputStream().read(ByteArray(128)) != -1) { }
                            } else socket.getInputStream().read(ByteArray(128))
                        }
                    }
                } catch (_: java.io.IOException) { }
            }
        }
        override fun close() { server.close(); worker.join(4000) }
    }
}
