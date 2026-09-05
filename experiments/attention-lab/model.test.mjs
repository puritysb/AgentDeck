import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, replay, selectSession, waitingSessions, canAnswer, answer } from './model.mjs';

const fixture = (scenario = 'quiet', count = 5) => replay(createState(), scenario, count);
const api = (state) => state.sessions.find((s) => s.id === 'api');
const respond = (state) => answer(state, 'api', api(state).request.id, api(state).request.choices[0]);

test('fixtures have distinct IDs at all supported counts, including duplicate project names', () => {
  for (const count of [1, 5, 12]) {
    const state = fixture('quiet', count);
    assert.equal(state.sessions.length, count);
    assert.equal(new Set(state.sessions.map((s) => s.id)).size, count);
  }
  assert.equal(fixture().sessions.filter((s) => s.project === 'API Client').length, 2);
  assert.throws(() => fixture('quiet', 2));
  assert.throws(() => fixture('made-up'));
});
test('new waits preserve selection, pin and stable session order', () => {
  const before = selectSession(fixture(), 'docs');
  const after = replay(before, 'multiple');
  assert.equal(after.selected, 'docs');
  assert.equal(after.pinned, true);
  assert.deepEqual(
    after.sessions.map((s) => s.id),
    before.sessions.map((s) => s.id),
  );
  assert.equal(waitingSessions(after).length, 2);
});
test('reducing fixtures falls back only when selected session is absent', () => {
  const before = selectSession(fixture(), 'docs');
  const after = replay(before, 'quiet', 1);
  assert.equal(after.selected, 'api');
  assert.equal(after.pinned, false);
});
test('observing a permission is not permission to answer it', () => {
  const state = fixture('waiting');
  assert.equal(canAnswer(state, api(state)), false);
  assert.equal(respond(state).actionLog.length, 0);
  const upgraded = { ...state, nativeReply: true };
  assert.equal(canAnswer(upgraded, api(upgraded)), true);
  assert.equal(respond(upgraded).actionLog.length, 1);
});
test('unknown request kinds and another session do not inherit capability', () => {
  const state = { ...fixture('waiting'), nativeReply: true };
  assert.equal(canAnswer(state, { ...api(state), id: 'another' }), false);
  assert.equal(canAnswer(state, { ...api(state), request: { ...api(state).request, kind: 'future-action' } }), false);
});
test('question answer only changes its exact session, once', () => {
  const state = fixture('question');
  const request = api(state).request;
  const after = respond(state);
  assert.equal(after.actionLog.length, 1);
  assert.equal(api(after).state, 'working');
  assert.equal(api(after).request, undefined);
  assert.deepEqual(
    after.sessions.filter((s) => s.id !== 'api'),
    state.sessions.filter((s) => s.id !== 'api'),
  );
  assert.equal(answer(after, 'api', request.id, request.choices[0]).actionLog.length, 1);
  assert.equal(answer(state, 'extra-3', request.id, request.choices[0]).actionLog.length, 0);
});
test('offline preserves last-observed waiting context and rejects responses', () => {
  const state = { ...fixture('offline'), nativeReply: true };
  assert.equal(waitingSessions(state).length, 1);
  assert.equal(api(state).request.live, true);
  assert.equal(canAnswer(state, api(state)), false);
  assert.equal(respond(state).actionLog.length, 0);
});
test('expired requests remain contextual but cannot be answered', () => {
  const state = fixture('expired');
  assert.ok(api(state).request);
  assert.equal(waitingSessions(state).length, 0);
  assert.equal(api(state).state, 'unknown');
  assert.equal(respond(state).actionLog.length, 0);
});
test('stale request IDs and unknown choices are rejected', () => {
  const before = fixture('question');
  const after = replay(before, 'question');
  assert.equal(answer(after, 'api', api(before).request.id, api(before).request.choices[0]).actionLog.length, 0);
  assert.equal(answer(after, 'api', api(after).request.id, 'invented').actionLog.length, 0);
});
test('reply arrival means idle with a report, not verified completion', () => {
  const state = fixture('reply');
  assert.equal(state.unread, 1);
  assert.equal(api(state).state, 'idle');
  assert.equal(api(state).completed, undefined);
  assert.ok(api(state).lastReply);
});
