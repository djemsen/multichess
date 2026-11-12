(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChessClock = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_MS = 10 * 60 * 1000;

  function create(ms) {
    var total = typeof ms === 'number' && ms > 0 ? ms : DEFAULT_MS;
    return { w: total, b: total, active: null, since: null };
  }

  function start(clock, color, now) {
    if (!clock || (color !== 'w' && color !== 'b')) return null;
    clock.active = color;
    clock.since = typeof now === 'number' ? now : Date.now();
    return clock;
  }

  function remaining(clock, color, now) {
    if (!clock || (color !== 'w' && color !== 'b')) return null;
    var value = Number(clock[color]);
    if (!isFinite(value)) return null;

    if (clock.active === color && typeof clock.since === 'number') {
      var at = typeof now === 'number' ? now : Date.now();
      value -= Math.max(0, at - clock.since);
    }

    return Math.max(0, Math.round(value));
  }

  function commit(clock, now) {
    if (!clock || !clock.active) return null;
    var color = clock.active;
    var value = remaining(clock, color, now);
    clock[color] = value;
    clock.active = null;
    clock.since = null;
    return { color: color, remaining: value };
  }

  function snapshot(clock, now) {
    if (!clock) return null;
    return {
      w: remaining(clock, 'w', now),
      b: remaining(clock, 'b', now),
      active: clock.active
    };
  }

  function format(ms) {
    var total = Math.max(0, Math.ceil(Number(ms) / 1000));
    if (!isFinite(total)) total = 0;
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  return {
    DEFAULT_MS: DEFAULT_MS,
    create: create,
    start: start,
    remaining: remaining,
    commit: commit,
    snapshot: snapshot,
    format: format
  };
});
