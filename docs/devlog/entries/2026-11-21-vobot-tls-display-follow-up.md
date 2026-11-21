# 2026-11-21 — Vobot TLS display verification remains open

### What blocked the device test

The Vobot D1 on firmware 1.2.6 booted AgentDeck and sent USB output on two Mac ports. With Developer Mode confirmed and the daemon's serial connections suspended, the dock still did not return a MicroPython prompt. Thonny reported `Device is busy`. Serial management resumed after the attempts. The updated receiver was never installed, so there are no device brightness readings for this change.

### Follow-up on the physical dock

- [ ] Establish a responsive developer console. Install the updated receiver and provision a credential with `display-state.read`. Confirm the running dock requests and receives `display_state` from the updated daemon over TLS.
- [ ] Record the awake brightness. Send an explicit sleep event in `off` mode and confirm the screen goes black. Send two consecutive `display_state` events without `displayOn`, first with no dim instruction and then with dimming disabled. Confirm brightness and blackout overlay state after each event. Send an explicit wake and verify the overlay clears and brightness returns to the recorded value.
- [ ] Repeat with `min` at 25% and an initial brightness above 25%. Confirm the screen stays readable at 25% through both partial events and returns to its original brightness on wake. Record the measured values alongside the TLS event sequence.
