*** Settings ***
Documentation       ESP32 serial JSON protocol compatibility tests (BDD style).
...                 Requires physical ESP32 with full firmware flashed.
...                 Uses Test Template to run the same protocol scenarios
...                 across all board variants.
Resource            ../resources/bdd_keywords.robot
Force Tags          hw    protocol
Suite Teardown      Disconnect Device

*** Test Cases ***
# ═══════════════════════════════════════════════════════════════════
# Device Info
# ═══════════════════════════════════════════════════════════════════

Box 86 Device Info
    [Template]    Device Info Scenario
    box_86

IPS 3.5 Device Info
    [Template]    Device Info Scenario
    ips_35

Round AMOLED Device Info
    [Template]    Device Info Scenario
    round_amoled

Ulanzi TC001 Device Info
    [Template]    Device Info Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# State Updates
# ═══════════════════════════════════════════════════════════════════

Box 86 State Update
    [Template]    State Update Scenario
    box_86

IPS 3.5 State Update
    [Template]    State Update Scenario
    ips_35

Round AMOLED State Update
    [Template]    State Update Scenario
    round_amoled

Ulanzi TC001 State Update
    [Template]    State Update Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# State Update With Options
# ═══════════════════════════════════════════════════════════════════

Box 86 State Update With Options
    [Template]    State Update With Options Scenario
    box_86

IPS 3.5 State Update With Options
    [Template]    State Update With Options Scenario
    ips_35

Round AMOLED State Update With Options
    [Template]    State Update With Options Scenario
    round_amoled

Ulanzi TC001 State Update With Options
    [Template]    State Update With Options Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# Usage & Sessions
# ═══════════════════════════════════════════════════════════════════

Box 86 Usage Update
    [Template]    Usage Update Scenario
    box_86

Box 86 Sessions List
    [Template]    Sessions List Scenario
    [Teardown]    Disconnect Device
    box_86

T-Embed Sessions List
    [Teardown]    Disconnect Device
    ${port}=    Get Inventory Port    t_embed
    ${available}=    Evaluate    bool($port and os.path.exists($port))    modules=os
    Skip If    not ${available}    No T-Embed at the inventory port
    Open ESP32 Serial    ${port}
    Exercise Sessions List    t_embed    awaiting_option

# ═══════════════════════════════════════════════════════════════════
# Display Control
# ═══════════════════════════════════════════════════════════════════

Box 86 Display On Off
    [Template]    Display On Off Scenario
    box_86

IPS 3.5 Display On Off
    [Template]    Display On Off Scenario
    ips_35

Round AMOLED Display On Off
    [Template]    Display On Off Scenario
    round_amoled

# ═══════════════════════════════════════════════════════════════════
# Error Recovery (critical for all devices)
# ═══════════════════════════════════════════════════════════════════

Box 86 Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    box_86

IPS 3.5 Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    ips_35

Round AMOLED Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    round_amoled

Ulanzi TC001 Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# Stress / Edge Cases
# ═══════════════════════════════════════════════════════════════════

Box 86 Empty Lines
    [Template]    Empty Line Handling Scenario
    box_86

Box 86 Large Message
    [Template]    Large Message Scenario
    box_86

Box 86 Rapid Burst
    [Template]    Rapid Burst Scenario
    box_86

Box 86 Unknown Message Type
    [Template]    Unknown Message Type Scenario
    box_86

# ═══════════════════════════════════════════════════════════════════
# State Transitions
# ═══════════════════════════════════════════════════════════════════

Box 86 State Cycle
    [Template]    State Cycle Scenario
    box_86

IPS 3.5 State Cycle
    [Template]    State Cycle Scenario
    ips_35

Round AMOLED State Cycle
    [Template]    State Cycle Scenario
    round_amoled

Ulanzi TC001 State Cycle
    [Template]    State Cycle Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# Timeline Events
# ═══════════════════════════════════════════════════════════════════

Box 86 Timeline Event
    [Template]    Timeline Event Scenario
    box_86

Box 86 Timeline History
    [Template]    Timeline History Scenario
    box_86

# ═══════════════════════════════════════════════════════════════════
# WiFi & Connection
# ═══════════════════════════════════════════════════════════════════

Box 86 WiFi Provision
    [Template]    WiFi Provision Scenario
    box_86

Box 86 Connection Status
    [Template]    Connection Status Scenario
    box_86

# ═══════════════════════════════════════════════════════════════════
# Boundary Values
# ═══════════════════════════════════════════════════════════════════

Box 86 Usage Zero Percent
    [Template]    Usage Boundary Scenario
    box_86    ${0}    ${0}

Box 86 Usage Full Percent
    [Template]    Usage Boundary Scenario
    box_86    ${100}    ${100}

Box 86 Many Options
    [Template]    Many Options Scenario
    box_86

Box 86 Empty Options
    [Template]    Empty Options Scenario
    box_86

*** Keywords ***
# ───────────────────────────────────────────────────────────────────

Device Info Scenario
    [Documentation]    Request device_info and verify all fields.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a device info request
    Then the device should respond with device info
    And the device info should contain valid fields
    And the device info board should be valid

State Update Scenario
    [Documentation]    Send state_update and verify no crash.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a state update with state "processing"
    Then the device should still be responsive

State Update With Options Scenario
    [Documentation]    Send state_update with options array.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a state update with options
    Then the device should still be responsive

Usage Update Scenario
    [Documentation]    Send usage_update and verify acceptance.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a usage update
    Then the device should still be responsive

Sessions List Scenario
    [Documentation]    Send multi-session list.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    Exercise Sessions List    86box    processing

Exercise Sessions List
    [Arguments]    ${expected_board}    ${first_state}
    ${info}=    Get Device Info
    Should Be Equal    ${info}[board]    ${expected_board}
    TRY
        Wait Until Keyword Succeeds    3x    500ms    Load Test Sessions    ${first_state}
    FINALLY
        Wait Until Keyword Succeeds    3x    0s    Clear Test Sessions
    END

Load Test Sessions
    [Arguments]    ${first_state}
    When I send a sessions list    ${first_state}
    Sleep    500ms
    ${info}=    Get Device Info
    Should Be Equal As Integers    ${info}[sessionCount]    2

Display On Off Scenario
    [Documentation]    Toggle display on/off.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send display state "off"
    And I send display state "on"
    Then the device should still be responsive

Malformed JSON Recovery Scenario
    [Documentation]    Send broken JSON, verify recovery.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send malformed JSON data
    Then the device should still be responsive
    When I send a device info request
    Then the device should respond with device info

Empty Line Handling Scenario
    [Documentation]    Empty lines should be silently ignored.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send empty lines
    Then the device should still be responsive
    When I send a device info request
    Then the device should respond with device info

Large Message Scenario
    [Documentation]    Messages near buffer limit should be handled.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a large message with project name of "200" characters
    Then the device should still be responsive

Rapid Burst Scenario
    [Documentation]    Rapid sequential messages should not overflow.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send "20" rapid messages
    Then the device should still be responsive

Unknown Message Type Scenario
    [Documentation]    Unknown types should be silently ignored.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send an unknown message type
    Then the device should still be responsive
    When I send a device info request
    Then the device should respond with device info

State Cycle Scenario
    [Documentation]    Cycle through all agent states and verify survival.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I cycle through states "idle, processing, awaiting_permission, awaiting_input, idle"
    Then the device should still be responsive
    When I send a device info request
    Then the device should respond with device info

Timeline Event Scenario
    [Documentation]    Send timeline_event and verify acceptance.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a timeline event
    Then the device should still be responsive

Timeline History Scenario
    [Documentation]    Send timeline_history batch and verify acceptance.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a timeline history
    Then the device should still be responsive

WiFi Provision Scenario
    [Documentation]    Send wifi_provision and verify device handles it.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a wifi provision message
    Then the device should still be responsive

Connection Status Scenario
    [Documentation]    Send connection status messages.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a connection status "connected"
    And I send a connection status "disconnected"
    Then the device should still be responsive

Usage Boundary Scenario
    [Documentation]    Send usage_update with boundary values.
    [Arguments]    ${board}    ${five_pct}    ${seven_pct}
    Given the ESP32 device "${board}" is connected and booted
    When I send usage at boundary "${five_pct}" and "${seven_pct}"
    Then the device should still be responsive

Many Options Scenario
    [Documentation]    Send awaiting_permission with 8 options.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a state update with many options
    Then the device should still be responsive

Empty Options Scenario
    [Documentation]    Send awaiting_permission with empty options array.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a state update with empty options
    Then the device should still be responsive
