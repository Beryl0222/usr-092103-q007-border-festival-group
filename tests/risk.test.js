import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";

const T0 = "2026-10-04T09:00:00+08:00";
const ACTIVITY_START = "2026-10-06T10:00:00+08:00";

function setup() {
  const sys = createSystem({ now: () => T0 });
  sys.members.createGroup({ group_id: "g-choir", program: "choir", name_zh: "中俄合唱交流团", capacity: 1 });
  sys.members.registerMember({ group_id: "g-choir", member_id: "m1", person_id: "p1", name_zh: "王磊", role: "leader" });
  sys.members.registerMember({ group_id: "g-choir", member_id: "m2", person_id: "p2", name_zh: "李雪" }); // 候补
  sys.eligibility.registerSource({
    source_id: "port-authority",
    authority: "口岸边防检查站",
    kinds: ["cross_border"],
    programs: ["choir"],
  });
  return sys;
}

test("风险总览标记资格、保险、紧急联系人、候补与资源缺口", () => {
  const sys = setup();
  const findings = sys.risk.groupRisks("g-choir", { activity_start: ACTIVITY_START });
  const codes = findings.map((f) => f.code);
  assert(codes.includes("MISSING_ELIGIBILITY"));
  assert(codes.includes("INSURANCE_MISSING"));
  assert(codes.includes("MISSING_EMERGENCY_CONTACT"));
  assert(codes.includes("UNASSIGNED_ROOM"));
  assert(codes.includes("UNASSIGNED_VEHICLE"));
  assert(codes.includes("WAITLIST_PENDING"));
  // 双语呈现
  const eligibilityFinding = findings.find((f) => f.code === "MISSING_ELIGIBILITY");
  assert(eligibilityFinding.message_zh.includes("王磊"));
  assert(eligibilityFinding.message_ru.length > 0);
});

test("补齐资料与资源后风险消除，保险临期单独提示", () => {
  const sys = setup();
  sys.eligibility.confirm({ member_id: "m1", program: "choir", kind: "cross_border", source_id: "port-authority" });
  sys.members.updateMember("m1", {
    insurance: { policy_ref: "POL-1", insurer: "平安", valid_until: "2026-10-05T00:00:00+08:00" },
    emergency_contact: { name: "王芳", phone: "13800000000", relation: "配偶" },
  });
  sys.inventory.registerResource({ resource_id: "room-301", kind: "room", capacity: 2, label: "标间 301" });
  sys.inventory.registerResource({ resource_id: "bus-a", kind: "vehicle", capacity: 45, label: "大巴 A" });
  sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h1", member_ids: ["m1"] });
  sys.inventory.placeHold({ resource_id: "bus-a", hold_id: "h2", member_ids: ["m1"] });

  const findings = sys.risk.groupRisks("g-choir", { activity_start: ACTIVITY_START });
  const m1Codes = findings.filter((f) => f.member_id === "m1").map((f) => f.code);
  assert(!m1Codes.includes("MISSING_ELIGIBILITY"));
  assert(!m1Codes.includes("INSURANCE_MISSING"));
  assert(!m1Codes.includes("MISSING_EMERGENCY_CONTACT"));
  assert(!m1Codes.includes("UNASSIGNED_ROOM"));
  assert(!m1Codes.includes("UNASSIGNED_VEHICLE"));
  assert(m1Codes.includes("INSURANCE_EXPIRED")); // 保险 10-05 到期，活动 10-06 开始
  const codes = findings.map((f) => f.code);
  assert(codes.includes("MISSING_ELIGIBILITY")); // 候补成员 m2 同样被纳入检查
  assert(codes.includes("WAITLIST_PENDING"));
});

test("口岸限流与导出时效进入调度员总览", () => {
  const sys = setup();
  sys.crossing.publishSlot({
    slot_id: "slot-1",
    port: "珲春口岸",
    start: "2026-10-06T08:00:00+08:00",
    end: "2026-10-06T12:00:00+08:00",
    capacity: 10,
  });
  sys.crossing.assignGroup({ slot_id: "slot-1", group_id: "g-choir" });
  sys.crossing.restrict({ slot_id: "slot-1", new_capacity: 3, reason: "临时限流" });
  sys.exports.issue({
    group_id: "g-choir",
    audience: "leader",
    recipient: "中方领队",
    purpose: "行前核对",
    ttl_seconds: 3600,
  });
  const overview = sys.risk.overview({ activity_start: ACTIVITY_START });
  const codes = overview["g-choir"].map((f) => f.code);
  assert(codes.includes("SLOT_RESTRICTED"));
  assert(codes.includes("EXPORT_EXPIRING"));
});
