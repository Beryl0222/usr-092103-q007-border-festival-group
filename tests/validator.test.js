import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

test("未知事件类型、未知聚合类型与非法时间被拒绝", () => {
  const errors = validateEvent({
    event_id: "x",
    event_type: "NOPE",
    aggregate_type: "unknown",
    aggregate_id: "a",
    occurred_at: "not-a-time",
    version: 1,
    summary: "s",
  });
  assert(errors.some((e) => e.includes("未知事件类型")));
  assert(errors.some((e) => e.includes("未知聚合类型")));
  assert(errors.some((e) => e.includes("occurred_at")));
});

test("事件存储产生的每条事件都符合领域约定", async () => {
  const { createSystem } = await import("../src/index.js");
  const sys = createSystem({ now: () => "2026-10-04T09:00:00+08:00" });
  sys.members.createGroup({ group_id: "g1", program: "choir", name_zh: "测试团", capacity: 1 });
  sys.members.registerMember({ group_id: "g1", member_id: "m1", person_id: "p1", name_zh: "王磊" });
  for (const event of sys.store.all()) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 不符合约定`);
  }
});
