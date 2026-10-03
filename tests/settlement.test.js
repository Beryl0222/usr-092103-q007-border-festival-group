import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";

const ACTIVITY_START = "2026-10-06T10:00:00+08:00";

function setup() {
  const sys = createSystem({ now: () => "2026-10-04T09:00:00+08:00" });
  sys.contracts.publish({
    contract_id: "c-hotel",
    version: 1,
    partner_id: "hotel-aurora",
    program: "choir",
    price_per_member_cents: 100000,
    cancellation_tiers: [
      { min_hours_before: 72, fee_percent: 0 },
      { min_hours_before: 24, fee_percent: 50 },
      { min_hours_before: 0, fee_percent: 100 },
    ],
    effective_from: "2026-09-01T00:00:00+08:00",
  });
  sys.members.createGroup({
    group_id: "g-choir",
    program: "choir",
    name_zh: "中俄合唱交流团",
    capacity: 10,
    contract_id: "c-hotel",
  });
  for (const [id, name] of [["m1", "王磊"], ["m2", "安娜"], ["m3", "李雪"]]) {
    sys.members.registerMember({ group_id: "g-choir", member_id: id, person_id: `p-${id}`, name_zh: name });
  }
  return sys;
}

test("取消责任按变更时点判定费率档位", () => {
  const sys = setup();
  // 活动前 49 小时退出 → 24~72 小时间 → 50%
  sys.clock.set("2026-10-04T09:00:00+08:00");
  const early = sys.withdrawMember("m1", { reason: "签证延误", activity_id: "act-1", activity_start: ACTIVITY_START });
  assert.equal(early.assessment.payload.fee_percent, 50);
  assert.equal(early.assessment.payload.fee_cents, 50000);
  // 活动前 2 小时退出 → 100%
  sys.clock.set("2026-10-06T08:00:00+08:00");
  const late = sys.withdrawMember("m2", { reason: "突发疾病", activity_id: "act-1", activity_start: ACTIVITY_START });
  assert.equal(late.assessment.payload.fee_percent, 100);
  assert.equal(late.assessment.payload.fee_cents, 100000);
});

test("取消责任按变更时点生效的合同版本判定", () => {
  const sys = setup();
  // v2 自 10-05 起生效：48 小时外免责，48 小时内全责
  sys.contracts.publish({
    contract_id: "c-hotel",
    version: 2,
    partner_id: "hotel-aurora",
    program: "choir",
    price_per_member_cents: 100000,
    cancellation_tiers: [
      { min_hours_before: 48, fee_percent: 0 },
      { min_hours_before: 0, fee_percent: 100 },
    ],
    effective_from: "2026-10-05T00:00:00+08:00",
  });
  // 10-04 的变更仍按 v1：49 小时前 → 50%
  sys.clock.set("2026-10-04T09:00:00+08:00");
  const before = sys.withdrawMember("m1", { activity_id: "act-1", activity_start: ACTIVITY_START });
  assert.equal(before.assessment.payload.contract_version, 1);
  assert.equal(before.assessment.payload.fee_percent, 50);
  // 10-05 的变更按 v2：29 小时前 → 100%
  sys.clock.set("2026-10-05T05:00:00+08:00");
  const after = sys.withdrawMember("m2", { activity_id: "act-1", activity_start: ACTIVITY_START });
  assert.equal(after.assessment.payload.contract_version, 2);
  assert.equal(after.assessment.payload.fee_percent, 100);
});

test("结算以实际到访为依据，取消费用并入", () => {
  const sys = setup();
  sys.clock.set("2026-10-04T09:00:00+08:00");
  sys.withdrawMember("m1", { activity_id: "act-1", activity_start: ACTIVITY_START }); // 50% → 50000
  sys.clock.set("2026-10-06T10:05:00+08:00");
  sys.settlement.recordAttendance({ member_id: "m2", activity_id: "act-1", arrived_at: "2026-10-06T09:55:00+08:00" });
  sys.settlement.recordAttendance({ member_id: "m3", activity_id: "act-1", arrived_at: "2026-10-06T10:02:00+08:00" });

  const result = sys.settlement.computeSettlement({
    group: sys.members.getGroup("g-choir"),
    activity_id: "act-1",
    activity_start: ACTIVITY_START,
  });
  assert.equal(result.payload.attended_count, 2);
  assert.equal(result.payload.attendance_charges_cents, 200000);
  assert.equal(result.payload.cancellation_fee_cents, 50000);
  assert.equal(result.payload.total_cents, 250000);
  assert.equal(result.payload.currency, "CNY");
});
