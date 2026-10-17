import assert from "node:assert/strict";
import test from "node:test";
import { createLocalStatusMonitor } from "../.test-dist/src/local-status.js";

test("a runtime failure replaces running status and cannot be overwritten by an older probe", async () => {
  const changes = [];
  let resolve;
  const monitor = createLocalStatusMonitor(() => new Promise((done) => { resolve = done; }), (status) => changes.push(status));
  monitor.accept({ running: true });
  const pending = monitor.refresh();
  monitor.accept({ running: false });
  resolve({ running: true });
  await pending;
  assert.deepEqual(changes, [{ running: true }, { running: false }]);
});

test("unmount prevents both late probes and late runtime events from updating the screen", async () => {
  const changes = [];
  let resolve;
  const monitor = createLocalStatusMonitor(() => new Promise((done) => { resolve = done; }), (status) => changes.push(status));
  const pending = monitor.refresh();
  monitor.dispose();
  resolve(true);
  await pending;
  monitor.accept(false);
  await monitor.refresh();
  assert.deepEqual(changes, []);
});

test("overlapping focus and periodic probes share one pending request", async () => {
  let calls = 0;
  let resolve;
  const monitor = createLocalStatusMonitor(() => { calls += 1; return new Promise((done) => { resolve = done; }); }, () => {});
  const first = monitor.refresh();
  const second = monitor.refresh();
  assert.equal(calls, 1);
  resolve(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test("failed health probe clears stale running status and a later probe can recover", async () => {
  const changes = [];
  let fail = true;
  const monitor = createLocalStatusMonitor(async () => { if (fail) throw new Error("offline"); return true; }, (status) => changes.push(status));
  monitor.accept(true);
  assert.equal(await monitor.refresh(), null);
  fail = false;
  assert.equal(await monitor.refresh(), true);
  assert.deepEqual(changes, [true, null, true]);
});

test("a stale failed probe cannot clear a newer successful runtime status", async () => {
  const changes = [];
  let reject;
  const monitor = createLocalStatusMonitor(() => new Promise((_, fail) => { reject = fail; }), (status) => changes.push(status));
  const pending = monitor.refresh();
  monitor.accept(true);
  reject(new Error("old failure"));
  await pending;
  assert.deepEqual(changes, [true]);
});
