import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";

function setup() {
  const sys = createSystem({ now: () => "2026-10-04T09:00:00+08:00" });
  sys.members.createGroup({ group_id: "g-choir", program: "choir", name_zh: "中俄合唱交流团", capacity: 10 });
  sys.members.createGroup({ group_id: "g-sports", program: "sports", name_zh: "体育大会团", capacity: 10 });
  sys.members.registerMember({ group_id: "g-choir", member_id: "c1", person_id: "p1", name_zh: "王磊", role: "leader" });
  sys.members.registerMember({ group_id: "g-choir", member_id: "c2", person_id: "p2", name_zh: "安娜" });
  sys.members.registerMember({ group_id: "g-choir", member_id: "c3", person_id: "p3", name_zh: "李雪" });
  sys.members.registerMember({ group_id: "g-sports", member_id: "s1", person_id: "p4", name_zh: "伊万", role: "leader" });
  sys.members.registerMember({ group_id: "g-sports", member_id: "s2", person_id: "p5", name_zh: "彼得" });
  sys.members.registerMember({ group_id: "g-sports", member_id: "s3", person_id: "p6", name_zh: "娜佳" });
  sys.crossing.publishSlot({
    slot_id: "slot-1",
    port: "珲春口岸",
    start: "2026-10-06T08:00:00+08:00",
    end: "2026-10-06T12:00:00+08:00",
    capacity: 10,
  });
  sys.crossing.assignGroup({ slot_id: "slot-1", group_id: "g-choir" });
  sys.crossing.assignGroup({ slot_id: "slot-1", group_id: "g-sports" });
  return sys;
}

test("限流后按团队关系分批：团组不拆散，行程只改期不删除", () => {
  const sys = setup();
  sys.crossing.restrict({ slot_id: "slot-1", new_capacity: 3, reason: "口岸临时限流" });
  const proposal = sys.crossing.proposeBatching({ slot_id: "slot-1" });

  assert.equal(proposal.batches.length, 2);
  // 每批不超限流容量，且每个团组整体落在同一批
  for (const batch of proposal.batches) {
    assert(batch.size <= 3);
    assert.equal(batch.groups.every((g) => !g.split), true);
  }
  assert.deepEqual(proposal.batches[0].groups[0].member_ids, ["c1", "c2", "c3"]);
  assert.deepEqual(proposal.batches[1].groups[0].member_ids, ["s1", "s2", "s3"]);
  // 批次窗口落在原时段内且互不重叠
  assert(Date.parse(proposal.batches[0].window.start) >= Date.parse("2026-10-06T08:00:00+08:00"));
  assert(Date.parse(proposal.batches.at(-1).window.end) <= Date.parse("2026-10-06T12:00:00+08:00"));

  // 行程保留：只追加改期事件，没有任何删除
  const rescheduled = sys.store.ofType("CROSSING_RESCHEDULED");
  assert.equal(rescheduled.length, 2);
  assert.equal(rescheduled[0].payload.reason, "flow_restriction");
  assert.equal(sys.crossing.get("slot-1").assignments.length, 2);
});

test("单团超过限流容量时按成员顺序拆分，领队在第一批", () => {
  const sys = createSystem({ now: () => "2026-10-04T09:00:00+08:00" });
  sys.members.createGroup({ group_id: "g-trade", program: "trade", name_zh: "口岸贸易团", capacity: 10 });
  sys.members.registerMember({ group_id: "g-trade", member_id: "t1", person_id: "p1", name_zh: "王磊", role: "leader" });
  for (const [id, name] of [["t2", "赵一"], ["t3", "钱二"], ["t4", "孙三"], ["t5", "李四"]]) {
    sys.members.registerMember({ group_id: "g-trade", member_id: id, person_id: `p-${id}`, name_zh: name });
  }
  sys.crossing.publishSlot({
    slot_id: "slot-9",
    port: "绥芬河口岸",
    start: "2026-10-06T08:00:00+08:00",
    end: "2026-10-06T10:00:00+08:00",
    capacity: 10,
  });
  sys.crossing.assignGroup({ slot_id: "slot-9", group_id: "g-trade" });
  sys.crossing.restrict({ slot_id: "slot-9", new_capacity: 2, reason: "车道检修" });
  const proposal = sys.crossing.proposeBatching({ slot_id: "slot-9" });

  assert.equal(proposal.batches.length, 3);
  assert(proposal.batches.every((b) => b.size <= 2));
  assert.equal(proposal.batches[0].groups[0].member_ids[0], "t1"); // 领队首批通行
  assert(proposal.batches.every((b) => b.groups[0].split));
});

test("需求未超容量时不拆分", () => {
  const sys = setup();
  const proposal = sys.crossing.proposeBatching({ slot_id: "slot-1" });
  assert.equal(proposal.batches.length, 1);
  assert.equal(proposal.changed, false);
});
