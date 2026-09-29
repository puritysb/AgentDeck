package dev.agentdeck.net

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ProtocolTest {

    @Test
    fun `released model fields decode when additive residency metadata is present`() {
        // Production Protocol.kt is unchanged; released readers ignore the additions.
        val json = """{"type":"state_update","state":"idle","mlxModels":["gemma"],"mlxResidency":{"known":true,"models":["gemma"]},"ollamaStatus":{"available":true,"models":[{"name":"gemma","size":42,"sizeVram":0}],"installedModelsKnown":true,"residency":{"known":true,"models":[]}}}"""
        val event = parseBridgeMessage(json) as BridgeEvent.State
        assertEquals(listOf("gemma"), event.data.mlxModels)
        assertEquals(true, event.data.ollamaStatus?.available)
        assertEquals("gemma", event.data.ollamaStatus?.models?.first()?.name)
        assertEquals(0L, event.data.ollamaStatus?.models?.first()?.sizeVram)
    }

    @Test
    fun `stale Claude quota retires scopes and subscriptions while Codex survives`() {
        val holder = dev.agentdeck.state.AgentStateHolder.instance
        fun deliver(json: String) {
            BridgeConnection.instance.onEvent?.invoke(requireNotNull(parseBridgeMessage(json)))
        }
        val fresh = """{"type":"usage_update","usageStale":false,"fiveHourPercent":42,"scopedLimits":[{"label":"model","percent":80}],"extraUsageEnabled":true,"subscriptions":[{"name":"Claude"}],"codexRateLimits":{"primary":{"usedPercent":25}}}"""
        deliver(fresh)
        assertEquals(42.0, holder.state.value.usage.fiveHourPercent)
        deliver("""{"type":"usage_update","usageStale":true,"fiveHourPercent":42,"scopedLimits":[{"label":"model","percent":80}],"extraUsageEnabled":true,"subscriptions":[]}""")
        assertNull(holder.state.value.usage.fiveHourPercent)
        assertNull(holder.state.value.usage.scopedLimits)
        assertNull(holder.state.value.usage.extraUsageEnabled)
        assertTrue(holder.state.value.subscriptions.isEmpty())
        assertEquals(25.0, holder.state.value.codexRateLimits?.primary?.usedPercent)
        deliver(fresh)
        assertEquals(false, holder.state.value.usage.usageStale)
        assertEquals(42.0, holder.state.value.usage.fiveHourPercent)
        deliver("""{"type":"state_update","state":"idle","subscriptions":[]}""")
        assertTrue(holder.state.value.subscriptions.isEmpty())
    }

    // --- parseBridgeMessage: state_update ---

    @Test
    fun `parse state_update with idle state`() {
        val json = """{"type":"state_update","state":"idle","projectName":"AgentDeck","modelName":"opus-4"}"""
        val event = parseBridgeMessage(json)
        assertTrue(event is BridgeEvent.State)
        val state = (event as BridgeEvent.State).data
        assertEquals(AgentState.IDLE, state.state)
        assertEquals("AgentDeck", state.projectName)
        assertEquals("opus-4", state.modelName)
    }

    @Test
    fun `parse state_update with processing state and tool info`() {
        val json = """{"type":"state_update","state":"processing","currentTool":"Read","toolInput":"/src/main.ts","toolProgress":"reading"}"""
        val event = parseBridgeMessage(json) as BridgeEvent.State
        assertEquals(AgentState.PROCESSING, event.data.state)
        assertEquals("Read", event.data.currentTool)
        assertEquals("/src/main.ts", event.data.toolInput)
    }

    @Test
    fun `parse state_update with permission options`() {
        val json = """{"type":"state_update","state":"awaiting_permission","options":[{"label":"Allow","value":"yes","recommended":true},{"label":"Deny","value":"no"}],"question":"Allow file write?"}"""
        val event = parseBridgeMessage(json) as BridgeEvent.State
        assertEquals(AgentState.AWAITING_PERMISSION, event.data.state)
        assertEquals(2, event.data.options!!.size)
        assertEquals("Allow", event.data.options!![0].label)
        assertTrue(event.data.options!![0].recommended!!)
        assertEquals("Allow file write?", event.data.question)
    }

    @Test
    fun `parse state_update with agent capabilities`() {
        val json = """{"type":"state_update","state":"idle","agentType":"openclaw","agentCapabilities":{"type":"openclaw","hasTerminal":false,"hasOptionLists":true}}"""
        val event = parseBridgeMessage(json) as BridgeEvent.State
        assertEquals("openclaw", event.data.agentType)
        assertNotNull(event.data.agentCapabilities)
        assertFalse(event.data.agentCapabilities!!.hasTerminal)
        assertTrue(event.data.agentCapabilities!!.hasOptionLists)
    }

    @Test
    fun `parse state_update with model catalog`() {
        val json = """{"type":"state_update","state":"idle","modelCatalog":[{"name":"opus-4","role":"primary"},{"name":"sonnet-4","available":false}]}"""
        val event = parseBridgeMessage(json) as BridgeEvent.State
        assertEquals(2, event.data.modelCatalog!!.size)
        assertEquals("opus-4", event.data.modelCatalog!![0].name)
        assertEquals("primary", event.data.modelCatalog!![0].role)
        assertFalse(event.data.modelCatalog!![1].available)
    }

    @Test
    fun `parse state_update with ollama status`() {
        val json = """{"type":"state_update","state":"idle","ollamaStatus":{"available":true,"models":[{"name":"qwen2.5:7b","size":4500000000}]}}"""
        val event = parseBridgeMessage(json) as BridgeEvent.State
        assertTrue(event.data.ollamaStatus!!.available)
        assertEquals("qwen2.5:7b", event.data.ollamaStatus!!.models[0].name)
    }

    @Test
    fun `parse state_update ignores unknown fields`() {
        val json = """{"type":"state_update","state":"idle","futureField":"value","anotherNew":42}"""
        val event = parseBridgeMessage(json) as BridgeEvent.State
        assertEquals(AgentState.IDLE, event.data.state)
    }

    @Test
    fun `parse state_update with all permission modes`() {
        for ((jsonMode, expected) in listOf(
            "default" to PermissionMode.DEFAULT,
            "plan" to PermissionMode.PLAN,
            "acceptEdits" to PermissionMode.ACCEPT_EDITS,
            "dontAsk" to PermissionMode.DONT_ASK,
            "bypassPermissions" to PermissionMode.BYPASS_PERMISSIONS,
        )) {
            val json = """{"type":"state_update","state":"idle","permissionMode":"$jsonMode"}"""
            val event = parseBridgeMessage(json) as BridgeEvent.State
            assertEquals("mode=$jsonMode", expected, event.data.permissionMode)
        }
    }

    // --- parseBridgeMessage: usage_update ---

    @Test
    fun `parse usage_update with rate limits`() {
        val json = """{"type":"usage_update","inputTokens":50000,"outputTokens":12000,"fiveHourPercent":72.5,"sevenDayPercent":38.1,"fiveHourResetsAt":"2026-03-22T15:00:00Z"}"""
        val event = parseBridgeMessage(json) as BridgeEvent.Usage
        assertEquals(50000, event.data.inputTokens)
        assertEquals(12000, event.data.outputTokens)
        assertEquals(72.5, event.data.fiveHourPercent!!, 0.01)
        assertEquals(38.1, event.data.sevenDayPercent!!, 0.01)
    }

    @Test
    fun `parse usage_update with extra usage`() {
        val json = """{"type":"usage_update","extraUsageEnabled":true,"extraUsageMonthlyLimit":100.0,"extraUsageUsedCredits":42.5,"extraUsageUtilization":0.425}"""
        val event = parseBridgeMessage(json) as BridgeEvent.Usage
        assertTrue(event.data.extraUsageEnabled!!)
        assertEquals(100.0, event.data.extraUsageMonthlyLimit!!, 0.01)
        assertEquals(42.5, event.data.extraUsageUsedCredits!!, 0.01)
    }

    // --- parseBridgeMessage: connection ---

    @Test
    fun `parse connection connected with sessionId`() {
        val json = """{"type":"connection","status":"connected","sessionId":"abc123"}"""
        val event = parseBridgeMessage(json)
        assertTrue(event is BridgeEvent.Connected)
        assertEquals("abc123", (event as BridgeEvent.Connected).sessionId)
    }

    @Test
    fun `parse connection disconnected`() {
        val json = """{"type":"connection","status":"disconnected"}"""
        val event = parseBridgeMessage(json)
        assertTrue(event is BridgeEvent.Disconnected)
    }

    // --- parseBridgeMessage: display_state ---

    @Test
    fun `parse display_state sleep and wake`() {
        val sleepJson = """{"type":"display_state","displayOn":false}"""
        val wakeJson = """{"type":"display_state","displayOn":true}"""
        val sleep = parseBridgeMessage(sleepJson) as BridgeEvent.DisplaySleep
        val wake = parseBridgeMessage(wakeJson) as BridgeEvent.DisplaySleep
        assertFalse(sleep.displayOn)
        assertTrue(wake.displayOn)
        // No `dim` field ⇒ null (legacy full-off path).
        assertNull(sleep.dim)
    }

    @Test
    fun `parse display_state with dim instruction`() {
        val json = """{"type":"display_state","displayOn":false,"dim":{"enabled":true,"mode":"min","level":25}}"""
        val event = parseBridgeMessage(json) as BridgeEvent.DisplaySleep
        assertFalse(event.displayOn)
        val dim = event.dim!!
        assertTrue(dim.enabled)
        assertEquals("min", dim.mode)
        assertEquals(25, dim.level)
    }

    // --- parseBridgeMessage: sessions_list ---

    @Test
    fun `parse sessions_list`() {
        val json = """{"type":"sessions_list","sessions":[{"id":"s1","port":9121,"projectName":"Proj","agentType":"claude-code","alive":true,"state":"idle"},{"id":"s2","port":9122,"alive":false}]}"""
        val event = parseBridgeMessage(json) as BridgeEvent.SessionsList
        assertEquals(2, event.sessions.size)
        assertEquals("s1", event.sessions[0].id)
        assertEquals(9121, event.sessions[0].port)
        assertEquals("claude-code", event.sessions[0].agentType)
        assertFalse(event.sessions[1].alive)
    }

    // --- parseBridgeMessage: encoder_state ---

    @Test
    fun `parse encoder_state`() {
        val json = """{"type":"encoder_state","encoders":[{"slot":0,"encoderType":"utility","header":"Volume","value":"50%","icon":"🔊","accentColor":"#22D3EE"}],"takeoverActive":false}"""
        val event = parseBridgeMessage(json) as BridgeEvent.EncoderState
        assertEquals(1, event.encoders.size)
        assertEquals("utility", event.encoders[0].encoderType)
        assertEquals("Volume", event.encoders[0].header)
        assertEquals("50%", event.encoders[0].value)
        assertFalse(event.takeoverActive)
    }

    // --- parseBridgeMessage: button_state ---

    @Test
    fun `parse button_state`() {
        val json = """{"type":"button_state","buttons":[{"slot":0,"title":"Mode","bgColor":"#1E293B","textColor":"#E2E8F0","icon":"⚡","badge":"P"}]}"""
        val event = parseBridgeMessage(json) as BridgeEvent.ButtonState
        assertEquals(1, event.buttons.size)
        assertEquals("Mode", event.buttons[0].title)
        assertEquals("#1E293B", event.buttons[0].bgColor)
        assertEquals("P", event.buttons[0].badge)
    }

    // --- parseBridgeMessage: timeline events ---

    @Test
    fun `parse timeline_event`() {
        val json = """{"type":"timeline_event","entry":{"ts":1711100000000,"type":"tool_request","raw":"Read file.ts","detail":"path: /src/file.ts"},"upsert":false}"""
        val event = parseBridgeMessage(json) as BridgeEvent.Timeline
        assertEquals("tool_request", event.entry.type)
        assertEquals("Read file.ts", event.entry.raw)
        assertEquals("path: /src/file.ts", event.entry.detail)
        assertFalse(event.upsert)
    }

    @Test
    fun `parse timeline_event with fractional timestamps`() {
        val json = """{"type":"timeline_event","entry":{"ts":1711100000000.75,"startedAt":1711100000000.25,"endedAt":1711100001234.99,"type":"chat_end","raw":"Completed"}}"""
        val event = parseBridgeMessage(json) as BridgeEvent.Timeline
        assertEquals(1711100000000L, event.entry.ts)
        assertEquals(1711100000000L, event.entry.startedAt)
        assertEquals(1711100001234L, event.entry.endedAt)
    }

    @Test
    fun `parse timeline_event upsert`() {
        val json = """{"type":"timeline_event","entry":{"ts":1711100000000,"type":"chat_end","raw":"Updated summary"},"upsert":true}"""
        val event = parseBridgeMessage(json) as BridgeEvent.Timeline
        assertTrue(event.upsert)
    }

    @Test
    fun `parse timeline_history`() {
        val json = """{"type":"timeline_history","entries":[{"ts":1000,"type":"chat_start","raw":"Hello"},{"ts":2000,"type":"chat_end","raw":"Done"}]}"""
        val event = parseBridgeMessage(json) as BridgeEvent.TimelineHistory
        assertEquals(2, event.entries.size)
    }

    // --- parseBridgeMessage: user_prompt ---

    @Test
    fun `parse user_prompt`() {
        val json = """{"type":"user_prompt","text":"fix the bug"}"""
        val event = parseBridgeMessage(json) as BridgeEvent.UserPrompt
        assertEquals("fix the bug", event.text)
    }

    // --- parseBridgeMessage: voice_state ---

    @Test
    fun `parse voice_state`() {
        val json = """{"type":"voice_state","state":"recording","text":"hello world"}"""
        val event = parseBridgeMessage(json) as BridgeEvent.Voice
        assertEquals("recording", event.data.state)
        assertEquals("hello world", event.data.text)
    }

    // --- parseBridgeMessage: edge cases ---

    @Test
    fun `parse unknown type returns null`() {
        val json = """{"type":"future_event","data":"something"}"""
        assertNull(parseBridgeMessage(json))
    }

    @Test
    fun `parse missing type returns null`() {
        val json = """{"data":"no type field"}"""
        assertNull(parseBridgeMessage(json))
    }

    @Test
    fun `parse invalid json returns null`() {
        assertNull(parseBridgeMessage("{invalid"))
        assertNull(parseBridgeMessage(""))
    }

    // --- BridgeTimelineEntry.toTimelineEntry ---

    @Test
    fun `BridgeTimelineEntry converts to TimelineEntry`() {
        val bridge = BridgeTimelineEntry(
            ts = 1711100000000,
            type = "tool_request",
            raw = "Read file.ts",
            detail = "path details",
            agentType = "claude-code",
            status = "resolved",
        )
        val entry = bridge.toTimelineEntry()
        assertEquals(1711100000000, entry.timestamp)
        assertEquals("tool_request", entry.type)
        assertEquals("Read file.ts", entry.summary)
        assertEquals("path details", entry.detail)
        assertEquals("claude-code", entry.agentType)
        assertEquals("resolved", entry.status)
    }

    // --- PluginCommands ---

    @Test
    fun `PluginCommands respond generates valid JSON`() {
        val json = PluginCommands.respond("yes")
        assertTrue(json.contains("\"type\":\"respond\""))
        assertTrue(json.contains("\"value\":\"yes\""))
    }

    @Test
    fun `PluginCommands respond escapes special characters`() {
        val json = PluginCommands.respond("say \"hello\"")
        assertTrue(json.contains("\\\"hello\\\""))
    }

    @Test
    fun `PluginCommands selectOption generates valid JSON`() {
        val json = PluginCommands.selectOption(2)
        assertEquals("""{"type":"select_option","index":2}""", json)
    }

    @Test
    fun `PluginCommands interrupt and escape`() {
        assertEquals("""{"type":"interrupt"}""", PluginCommands.interrupt())
        assertEquals("""{"type":"escape"}""", PluginCommands.escape())
    }

    @Test
    fun `PluginCommands utility with and without value`() {
        val withVal = PluginCommands.utility("set_volume", 75)
        assertTrue(withVal.contains("\"action\":\"set_volume\""))
        assertTrue(withVal.contains("\"value\":75"))

        val without = PluginCommands.utility("toggle_mute")
        assertTrue(without.contains("\"action\":\"toggle_mute\""))
        assertFalse(without.contains("value"))
    }

    @Test
    fun `PluginCommands navigateOption`() {
        assertEquals("""{"type":"navigate_option","direction":"up"}""", PluginCommands.navigateOption("up"))
    }

    // --- deck_slot_map ---

    @Test
    fun `parse deck_slot_map`() {
        val json = """{"type":"deck_slot_map","buttons":[{"slot":0,"actionType":"mode"}],"encoders":[{"slot":0,"actionType":"utility"}]}"""
        val event = parseBridgeMessage(json) as BridgeEvent.SlotMap
        assertEquals(1, event.buttons.size)
        assertEquals("mode", event.buttons[0].actionType)
        assertEquals(1, event.encoders.size)
        assertEquals("utility", event.encoders[0].actionType)
    }

    // Captured verbatim off a live Swift daemon on 2026-09-01, not composed
    // from what the decoder expects: a fixture built from the reader's own
    // field list agrees with it forever and cannot catch a producer that
    // emits a shape the reader refuses. Every Android device on this fleet
    // was logging "Unparsed WS message" for exactly this frame.
    private val liveSwiftDaemonSessionsFrame = "{\"sessions\":[{\"alive\":true,\"agentType\":\"openclaw\",\"projectName\":\"OpenClaw\",\"modelName\":\"zai\\/glm-5.2\",\"port\":18789,\"id\":\"openclaw-gateway\",\"state\":\"idle\",\"startedAt\":\"2026-08-31T16:07:39Z\"},{\"agentType\":\"claude-code\",\"liveAnswerable\":false,\"startedAt\":\"2026-08-31T22:12:15Z\",\"projectName\":\"AgentDeck\",\"state\":\"processing\",\"port\":9120,\"alive\":true,\"currentTool\":\"Bash\",\"lastEventHm\":\"07:21\",\"activity\":\"Building the AgentDeck CLI\",\"elapsedSec\":720,\"controlMode\":\"observed\",\"id\":\"adfef38f-28c8-4636-938b-5a62efa40822\",\"lastEventText\":\"cremas 연결했다.\",\"lastEventTask\":\"Task 1\"},{\"controlMode\":\"observed\",\"startedAt\":\"2026-08-31T22:12:27Z\",\"id\":\"6648f5ce-e0db-4245-a9c4-5c949b94cd41\",\"lastEventText\":\"조사 세션이 **내 요건 자체를 무너뜨렸고, 그게 맞았다.**\\n\\n## 코드가 답을 줬다\\n\\n```gdscript\\nfunc _person_era_arrived(person: NpcPerson) -> bool:\\n    return era_index != -1 and era_index <= current_era_index\\n```\\n\\n`appear_era_id`는 *\",\"liveAnswerable\":false,\"state\":\"idle\",\"elapsedSec\":708,\"lastEventHm\":\"07:14\",\"projectName\":\"epoch-of-tech\",\"agentType\":\"claude-code\",\"subagents\":{\"completed\":1,\"lastCompletedAt\":1788214664925.6821,\"active\":0,\"peak\":0},\"port\":9120,\"alive\":true},{\"liveAnswerable\":false,\"controlMode\":\"observed\",\"startedAt\":\"2026-08-31T22:12:27Z\",\"lastEventHm\":\"07:15\",\"state\":\"idle\",\"subagents\":{\"peak\":3,\"completed\":46,\"active\":3,\"lastCompletedAt\":1788215053018.342},\"agentType\":\"claude-code\",\"lastEventText\":\"## b69 조사 착수 — 에이전트 3개 투입\\n\\n**확정된 것들**:\\n- 21인 목록 그대로 승인 (스팍존스·DESIGN\\/MEDIA 엔지니어 0·b67 원장 연결 호평)\\n- 계약 오류 3건이 저의 착수 전 질문으로 잡혀 피어가 수정: `living` 쿼터 폐지(은퇴≠생존, 생존 인물은 공개 직업 사실만), `country`=경력 주 국가+`birth_cou\",\"port\":9120,\"elapsedSec\":708,\"projectName\":\"epoch-of-tech\",\"id\":\"add58e3f-96bc-4f3a-82c1-88e04e9d0184\",\"alive\":true},{\"liveAnswerable\":false,\"port\":9120,\"id\":\"codex:01a05883-fd4e-7de3-8354-4185c696684a\",\"projectName\":\"epoch-of-tech\",\"lastEventText\":\"Interrupted · 1m 36s · 실제 게임 플레이가 스토리를 만들어낼 수 있는지 검증한다.\",\"lastEventHm\":\"00:54\",\"startedAt\":\"2026-08-31T22:12:19Z\",\"alive\":true,\"state\":\"processing\",\"agentType\":\"codex-cli\",\"controlMode\":\"observed\",\"elapsedSec\":716},{\"state\":\"processing\",\"elapsedSec\":700,\"agentType\":\"codex-cli\",\"id\":\"codex:01a05885-c5e3-7ce0-9c45-06ec2f04a6fd\",\"startedAt\":\"2026-08-31T22:12:35Z\",\"projectName\":\"pocket-daily\",\"controlMode\":\"observed\",\"alive\":true,\"liveAnswerable\":false,\"port\":9120}],\"type\":\"sessions_list\"}"

    @Test
    fun `a real sessions_list frame from the Swift daemon parses`() {
        val event = parseBridgeMessage(liveSwiftDaemonSessionsFrame)
        assertNotNull("live sessions_list frame must parse", event)
        assertTrue(event is BridgeEvent.SessionsList)
    }

}
