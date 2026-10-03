import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";
import { ConcurrencyError } from "../src/events.js";

const T0 = "2026-10-04T09:00:00+08:00";

function setup() {
  const sys = createSystem({ now: () => T0 });
  sys.inventory.registerResource({ resource_id: "room-301", kind: "room", capacity: 2, label: "标间 301" });
  sys.inventory.registerResource({ resource_id: "bus-a", kind: "vehicle", capacity: 1, label: "大巴 A" });
  return sys;
}

test("多人共用预订：一间房一条预订记录两名成员", () => {
  const sys = setup();
  sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h1", member_ids: ["m1", "m2"] });
  assert.equal(sys.inventory.occupancy("room-301"), 2);
  assert.equal(sys.inventory.assignmentFor("m1", "room"), "标间 301");
  assert.equal(sys.inventory.assignmentFor("m2", "room"), "标间 301");
  // 共用预订的第三名成员超售被拒
  assert.throws(() => sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h2", member_ids: ["m3"] }), /容量不足/);
});

test("并发预订：过期版本被拒，重试后容量校验兜底，绝不超售", () => {
  const sys = createSystem({ now: () => T0 });
  sys.inventory.registerResource({ resource_id: "bus-b", kind: "vehicle", capacity: 2, label: "大巴 B" });
  const v0 = sys.store.versionOf("inventory_resource", "bus-b"); // 1（RESOURCE_REGISTERED）
  sys.inventory.placeHold({ resource_id: "bus-b", hold_id: "h1", member_ids: ["m1"], expected_version: v0 });
  // 第二个并发写入方仍拿着 v0：容量够，但版本已过期，乐观并发控制拒绝
  assert.throws(
    () => sys.inventory.placeHold({ resource_id: "bus-b", hold_id: "h2", member_ids: ["m2"], expected_version: v0 }),
    ConcurrencyError,
  );
  // 重读版本后重试成功
  sys.inventory.placeHold({
    resource_id: "bus-b",
    hold_id: "h2",
    member_ids: ["m2"],
    expected_version: sys.store.versionOf("inventory_resource", "bus-b"),
  });
  // 容量已满，第三个写入方被容量校验兜底
  assert.throws(
    () =>
      sys.inventory.placeHold({
        resource_id: "bus-b",
        hold_id: "h3",
        member_ids: ["m3"],
        expected_version: sys.store.versionOf("inventory_resource", "bus-b"),
      }),
    /容量不足/,
  );
  assert.equal(sys.inventory.occupancy("bus-b"), 2);
});

test("同一成员在同一资源不可重复预订，释放后容量恢复", () => {
  const sys = setup();
  sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h1", member_ids: ["m1"] });
  assert.throws(() => sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h2", member_ids: ["m1"] }), /已有预订/);
  sys.inventory.releaseHold({ resource_id: "room-301", hold_id: "h1", reason: "调换房间" });
  assert.equal(sys.inventory.remaining("room-301"), 2);
  sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h3", member_ids: ["m1"] });
  assert.equal(sys.inventory.assignmentFor("m1", "room"), "标间 301");
});

test("占位超时未确认自动失效并留痕", () => {
  const sys = setup();
  sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h1", member_ids: ["m1"], ttl_seconds: 3600 });
  assert.equal(sys.inventory.expireHolds("2026-10-04T09:30:00+08:00").length, 0);
  const expired = sys.inventory.expireHolds("2026-10-04T10:00:01+08:00");
  assert.deepEqual(expired, ["h1"]);
  assert.equal(sys.inventory.occupancy("room-301"), 0);
  assert(sys.store.ofType("RESOURCE_HOLD_EXPIRED").length === 1);
});

test("预订确认状态流转留痕", () => {
  const sys = setup();
  sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h1", member_ids: ["m1"] });
  sys.inventory.confirmHold({ resource_id: "room-301", hold_id: "h1" });
  const types = sys.store.ofAggregate("inventory_resource", "room-301").map((e) => e.event_type);
  assert.deepEqual(types, ["RESOURCE_REGISTERED", "RESOURCE_HELD", "RESOURCE_HOLD_CONFIRMED"]);
});
