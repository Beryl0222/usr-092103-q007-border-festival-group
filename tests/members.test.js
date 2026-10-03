import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";

const NOW = "2026-10-04T09:00:00+08:00";

function setup(capacity = 2) {
  const sys = createSystem({ now: () => NOW });
  sys.members.createGroup({
    group_id: "g-choir",
    program: "choir",
    name_zh: "中俄合唱交流团",
    name_ru: "Китайско-российский хор",
    capacity,
    contract_id: "c-hotel",
    side: "cn",
  });
  return sys;
}

test("容量满后进入候补，退出后按报名顺序转正且全程留痕", () => {
  const sys = setup(2);
  sys.members.registerMember({ group_id: "g-choir", member_id: "m1", person_id: "p1", name_zh: "王磊" });
  sys.members.registerMember({ group_id: "g-choir", member_id: "m2", person_id: "p2", name_zh: "安娜", name_ru: "Анна" });
  const m3 = sys.members.registerMember({ group_id: "g-choir", member_id: "m3", person_id: "p3", name_zh: "李雪" });
  const m4 = sys.members.registerMember({ group_id: "g-choir", member_id: "m4", person_id: "p4", name_zh: "赵敏" });
  assert.equal(m3.status, "waitlisted");
  assert.equal(m3.waitlist_position, 1);
  assert.equal(m4.waitlist_position, 2);

  const { promotion } = sys.withdrawMember("m1", { reason: "个人原因" });
  assert.equal(promotion.event_type, "WAITLIST_PROMOTED");
  assert.equal(promotion.aggregate_id, "m3");
  assert.equal(promotion.payload.freed_by, "m1");
  assert.equal(sys.members.get("m3").status, "active");
  assert.equal(sys.members.get("m1").status, "withdrawn");

  // 过程保留：退出与转正都在事件流中，成员历史不被删除
  const history = sys.members.history("m1").map((e) => e.event_type);
  assert.deepEqual(history, ["MEMBER_REGISTERED", "MEMBER_WITHDRAWN"]);
  assert(sys.store.ofType("WAITLIST_PROMOTED").length === 1);
});

test("候补成员退出不触发转正，名额仍留给候补队列", () => {
  const sys = setup(1);
  sys.members.registerMember({ group_id: "g-choir", member_id: "m1", person_id: "p1", name_zh: "王磊" });
  sys.members.registerMember({ group_id: "g-choir", member_id: "m2", person_id: "p2", name_zh: "李雪" });
  const { promotion } = sys.withdrawMember("m2", { reason: "放弃候补" });
  assert.equal(promotion, null);
  assert.equal(sys.members.activeMembers("g-choir").length, 1);
});

test("同名成员按身份标识消歧，成员编号不可重复", () => {
  const sys = setup(10);
  sys.members.registerMember({
    group_id: "g-choir",
    member_id: "m1",
    person_id: "p-cn-001",
    name_zh: "王磊",
    birth_date: "1988-03-12",
    document_ref: "E12345678",
  });
  sys.members.registerMember({
    group_id: "g-choir",
    member_id: "m2",
    person_id: "p-cn-002",
    name_zh: "王磊",
    birth_date: "1995-07-01",
    document_ref: "E87654321",
  });
  const candidates = sys.members.disambiguate("g-choir", "王磊");
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => c.person_id).sort(),
    ["p-cn-001", "p-cn-002"],
  );
  // 只暴露非敏感区分项：出生年份与证件尾号，不暴露完整证件号
  assert.equal(candidates[0].birth_year.length, 4);
  assert.equal(candidates[0].document_tail.length, 2);
  assert(!("document_ref" in candidates[0]));
  assert.throws(
    () => sys.members.registerMember({ group_id: "g-choir", member_id: "m1", person_id: "p9", name_zh: "张三" }),
    /成员编号重复/,
  );
});

test("资料更新留痕但证件细节不进入事件载荷", () => {
  const sys = setup(10);
  sys.members.registerMember({ group_id: "g-choir", member_id: "m1", person_id: "p1", name_zh: "王磊" });
  sys.members.updateMember("m1", {
    document_ref: "E12345678",
    insurance: { policy_ref: "POL-1", insurer: "平安", valid_until: "2026-12-31" },
    emergency_contact: { name: "王芳", phone: "13800000000", relation: "配偶" },
  });
  const update = sys.store.ofType("MEMBER_UPDATED").at(-1);
  assert.deepEqual(update.payload.fields.sort(), ["document_ref", "emergency_contact", "insurance"].sort());
  assert(!JSON.stringify(update.payload).includes("E12345678"));
});
