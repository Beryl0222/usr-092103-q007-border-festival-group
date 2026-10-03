import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";
import { AuthorizationError } from "../src/events.js";

function setup() {
  const sys = createSystem({ now: () => "2026-10-04T09:00:00+08:00" });
  sys.members.createGroup({ group_id: "g-choir", program: "choir", name_zh: "中俄合唱交流团", capacity: 10 });
  sys.members.registerMember({ group_id: "g-choir", member_id: "m1", person_id: "p1", name_zh: "王磊" });
  sys.eligibility.registerSource({
    source_id: "port-authority",
    authority: "口岸边防检查站",
    kinds: ["cross_border"],
    programs: ["choir", "sports"],
  });
  return sys;
}

test("有权来源确认跨境资格，事件只记录状态与来源引用", () => {
  const sys = setup();
  const event = sys.eligibility.confirm({
    member_id: "m1",
    program: "choir",
    kind: "cross_border",
    source_id: "port-authority",
    valid_until: "2026-10-20",
  });
  assert.equal(event.event_type, "ELIGIBILITY_CONFIRMED");
  assert.equal(event.payload.result, "confirmed");
  assert.equal(event.payload.source_id, "port-authority");
  // 证件细节不进入资格事件
  assert(!("document_ref" in event.payload));
  assert.equal(sys.eligibility.status("m1", "cross_border"), "confirmed");
});

test("未登记来源、越权类型与越权项目均被拒绝", () => {
  const sys = setup();
  assert.throws(
    () => sys.eligibility.confirm({ member_id: "m1", program: "choir", kind: "cross_border", source_id: "travel-agency" }),
    AuthorizationError,
  );
  assert.throws(
    () => sys.eligibility.confirm({ member_id: "m1", program: "choir", kind: "health_check", source_id: "port-authority" }),
    AuthorizationError,
  );
  assert.throws(
    () => sys.eligibility.confirm({ member_id: "m1", program: "trade", kind: "cross_border", source_id: "port-authority" }),
    AuthorizationError,
  );
  assert.equal(sys.eligibility.status("m1", "cross_border"), "missing");
});

test("资格撤销后状态回退，过程留痕", () => {
  const sys = setup();
  sys.eligibility.confirm({ member_id: "m1", program: "choir", kind: "cross_border", source_id: "port-authority" });
  sys.eligibility.revoke({ member_id: "m1", program: "choir", kind: "cross_border", source_id: "port-authority", reason: "证件失效" });
  assert.equal(sys.eligibility.status("m1", "cross_border"), "revoked");
  assert.deepEqual(
    sys.store.ofAggregate("member_eligibility", "m1").map((e) => e.event_type),
    ["ELIGIBILITY_CONFIRMED", "ELIGIBILITY_REVOKED"],
  );
});
