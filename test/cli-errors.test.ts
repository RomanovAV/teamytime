import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliErrors } from '../src/server/agents/cli-errors';

test('missing model is preserved across fragmented stderr and auth stack frames', () => {
  const errors = new CliErrors(), activities: string[] = [];
  const text = "An unexpected critical error occurred:\nError: The selected model 'Qwen3.8-Flash-Next-262k' is not present in the current backend catalogue\n    at runWithBackendAuthChallenge (file:///opt/gigacode/lib/chunks/example.js:3:1124)";
  for (const byte of Buffer.from(text)) errors.feed(Buffer.from([byte]), text => activities.push(text));
  errors.end(text => activities.push(text));
  assert.match(errors.message(1), /модель отсутствует/);
  assert.doesNotMatch(errors.message(1), /авторизац/);
  assert.deepEqual(activities, []);
});

test('actual auth prompt without final newline is recognized with split UTF-8', () => {
  const errors = new CliErrors(), activities: string[] = [];
  for (const byte of Buffer.from('Выполните вход в терминале')) errors.feed(Buffer.from([byte]), text => activities.push(text));
  errors.end(text => activities.push(text));
  assert.match(errors.message(1), /запросил авторизацию/);
  assert.equal(activities.length, 1);
});

test('generic failure does not suggest authentication or expose stderr secrets', () => {
  const errors = new CliErrors();
  errors.feed(Buffer.from('Error: network unavailable token=SECRET\n at runWithBackendAuthChallenge (file:///example.js:1:2)\n'), () => assert.fail('false auth prompt'));
  errors.end(() => assert.fail('false auth prompt'));
  assert.match(errors.message(9), /кодом 9/);
  assert.doesNotMatch(errors.message(9), /авторизац|SECRET/);
});
