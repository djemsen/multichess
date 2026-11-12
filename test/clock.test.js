'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../public/clock.js');

test('clocks start with ten minutes per side', () => {
  const c = clock.create();
  assert.equal(clock.DEFAULT_MS, 10 * 60 * 1000);
  assert.equal(c.w, 600000);
  assert.equal(c.b, 600000);
  assert.equal(c.active, null);
});

test('only the active side counts down', () => {
  const c = clock.create();
  clock.start(c, 'w', 1000);

  assert.equal(clock.remaining(c, 'w', 61000), 540000);
  assert.equal(clock.remaining(c, 'b', 61000), 600000);

  const spent = clock.commit(c, 121000);

  assert.deepEqual(spent, { color: 'w', remaining: 480000 });
  assert.equal(c.w, 480000);
  assert.equal(c.b, 600000);
  assert.equal(c.active, null);
  assert.equal(c.since, null);
  assert.equal(clock.remaining(c, 'w', 999999), 480000);
});

test('clock snapshots show the remaining time at a moment', () => {
  const c = clock.create(5000);
  clock.start(c, 'b', 0);

  assert.deepEqual(clock.snapshot(c, 2000), { w: 5000, b: 3000, active: 'b' });
  assert.deepEqual(clock.snapshot(null), null);
});

test('clock values never go below zero', () => {
  const c = clock.create(1000);
  clock.start(c, 'w', 0);

  assert.equal(clock.remaining(c, 'w', 5000), 0);
  const spent = clock.commit(c, 5000);
  assert.deepEqual(spent, { color: 'w', remaining: 0 });
});

test('clock formatting is m:ss', () => {
  assert.equal(clock.format(600000), '10:00');
  assert.equal(clock.format(599999), '10:00');
  assert.equal(clock.format(590000), '9:50');
  assert.equal(clock.format(999), '0:01');
  assert.equal(clock.format(0), '0:00');
});
