import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore, ConcurrentModification } from "../src/domain/store.js";
import { Commands, CapacityExceeded } from "../src/domain/commands.js";
import { Projection } from "../src/domain/projection.js";
import { Views } from "../src/domain/views.js";
import { ExportLedger } from "../src/domain/exports.js";
import { decideCancellationLiability, redact } from "../src/domain/policy.js";

const PORT = { id: "port", kind: "port_authority" };
const AGENT = { id: "agent", kind: "travel_agent" };
const DISPATCHER = { id: "d1", role: "dispatcher" };
const L_CN = { id: "lcn", role: "leader", side: "domestic" };
const L_RU = { id: "lru", role: "leader", side: "foreign" };

function harness() {
  const store = new EventStore();
  const cmd = new Commands(store, { now: () => "2026-10-01T08:00:00+08:00" });
  return { store, cmd };
}

function seedGroup(cmd, group_id = "g1", activity_kind = "chorus") {
  cmd.createGroup({ group_id, activity_kind, name: "测试团", actor: DISPATCHER, source: { id: "s", kind: "festival_dispatch" } });
}

function seedMember(cmd, member_id, { group_id = "g1", side = "domestic", team_id = null, name = member_id } = {}) {
  cmd.registerMember({
    member_id, group_id, team_id, side, display_name: name,
    languages: [side === "foreign" ? "ru" : "zh"],
    actor: side === "foreign" ? L_RU : L_CN,
    phone: "p", emergency_contact: { name: "e", phone: "ep" },
    insurance: { policy_ref: "I" },
  });
}

// ================= 存储：版本与原子批次 =================
test("事件流版本单调且并发追加触发 CAS 冲突", () => {
  const { store } = harness();
  store.append({
    event_type: "GROUP_CREATED", aggregate_type: "travel_group", aggregate_id: "g",
    summary: "a", payload: { group_id: "g", activity_kind: "chorus", name: "g" },
  });
  assert.equal(store.version("g"), 1);
  assert.throws(
    () =>
      store.append({
        event_type: "GROUP_UPDATED", aggregate_type: "travel_group", aggregate_id: "g",
        summary: "b", payload: { group_id: "g", changes: {} },
      }, { expectedVersion: 0 }),
    ConcurrentModification,
  );
});

test("批次原子提交：版本连续，失败时不落库", () => {
  const { store } = harness();
  store.appendBatch([
    { event_type: "GROUP_CREATED", aggregate_type: "travel_group", aggregate_id: "g", summary: "1", payload: { group_id: "g", activity_kind: "chorus", name: "g" } },
    { event_type: "GROUP_UPDATED", aggregate_type: "travel_group", aggregate_id: "g", summary: "2", payload: { group_id: "g", changes: { x: 1 } } },
  ]);
  assert.equal(store.version("g"), 2);

  const before = store.log.length;
  assert.throws(() =>
    store.appendBatch(
      [
        { event_type: "GROUP_UPDATED", aggregate_type: "travel_group", aggregate_id: "g", summary: "3", payload: { group_id: "g", changes: { y: 1 } } },
        { event_type: "GROUP_UPDATED", aggregate_type: "travel_group", aggregate_id: "g", summary: "4", payload: { group_id: "g", changes: { z: 1 } } },
      ],
      { expectedVersions: { g: 99 } },
    ),
  );
  assert.equal(store.log.length, before, "冲突批次不写入任何事件");
});

test("JSONL 持久化后可重放恢复全部状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bfg-"));
  try {
    const path = join(dir, "log.jsonl");
    const s1 = await EventStore.fromFile(path);
    const c1 = new Commands(s1);
    seedGroup(c1, "gp");
    seedMember(c1, "mp", { group_id: "gp" });
    await new Promise((r) => setTimeout(r, 30)); // 等待异步追加落盘
    const s2 = await EventStore.fromFile(path);
    const p2 = Projection.build(s2);
    assert.ok(p2.groups.has("gp"));
    assert.ok(p2.members.has("mp"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ================= 容量：并发不超售 =================
test("高并发占位绝不超售，超额者全部进入候补", async () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  cmd.defineResource({ resource_id: "r1", kind: "vehicle", capacity: 5, label: "中巴", actor: DISPATCHER });
  for (let i = 0; i < 20; i++) seedMember(cmd, `m${i}`);

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      cmd.holdOrWaitlist({ resource_id: "r1", member_id: `m${i}`, hold_id: `h${i}`, actor: DISPATCHER }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);

  const p = Projection.build(store);
  assert.equal(p.usedCapacity("r1"), 5, "持有量恰为容量");
  assert.ok(p.usedCapacity("r1") <= p.resources.get("r1").capacity);
  assert.equal(p.waitlist("r1").length, 15, "其余 15 人全部候补");
  assert.deepEqual(p.waitlist("r1").map((h) => h.rank), Array.from({ length: 15 }, (_, i) => i + 1));
});

test("释放后按候补顺序自动转正，仍不超容量", async () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  cmd.defineResource({ resource_id: "r1", kind: "hotel_room", capacity: 2, label: "标间", actor: DISPATCHER });
  for (let i = 0; i < 4; i++) seedMember(cmd, `m${i}`);
  for (let i = 0; i < 4; i++) await cmd.holdOrWaitlist({ resource_id: "r1", member_id: `m${i}`, hold_id: `h${i}`, actor: DISPATCHER });

  await cmd.releaseHold({ hold_id: "h0", reason: "取消", actor: DISPATCHER });
  const p = Projection.build(store);
  assert.equal(p.usedCapacity("r1"), 2);
  assert.equal(p.holds.get("h2").state, "held", "候补第 1 位转正");
  assert.equal(p.holds.get("h3").state, "waitlisted", "候补第 2 位继续等待");
});

test("成员退出联动释放席位并转正候补，过程事件完整保留", async () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  cmd.defineResource({ resource_id: "r1", kind: "event_seat", capacity: 1, label: "席位", actor: DISPATCHER });
  seedMember(cmd, "a");
  seedMember(cmd, "b");
  await cmd.holdOrWaitlist({ resource_id: "r1", member_id: "a", hold_id: "ha", actor: DISPATCHER });
  await cmd.holdOrWaitlist({ resource_id: "r1", member_id: "b", hold_id: "hb", actor: DISPATCHER });
  await cmd.withdrawMember({ member_id: "a", reason: "生病", actor: L_CN });

  const p = Projection.build(store);
  assert.equal(p.members.get("a").status, "withdrawn");
  assert.deepEqual(p.members.get("a").withdrawals[0], { reason: "生病", at: "2026-10-01T08:00:00+08:00" });
  assert.equal(p.holds.get("ha").state, "released");
  assert.equal(p.holds.get("hb").state, "held");
  const types = store.stream("r1").map((e) => e.event_type);
  assert.deepEqual(types, ["RESOURCE_DEFINED", "RESOURCE_HELD", "WAITLIST_JOINED", "HOLD_RELEASED", "WAITLIST_PROMOTED"]);
});

// ================= 共用预订 =================
test("多人共用预订不得超过容量，挂接与移除均留痕", async () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  cmd.createBooking({ booking_id: "b1", kind: "hotel", group_id: "g1", supplier: "酒店", capacity: 2, contract_ref: "C", actor: DISPATCHER });
  seedMember(cmd, "a");
  seedMember(cmd, "b");
  seedMember(cmd, "c");
  await cmd.attachBookingMember({ booking_id: "b1", member_id: "a", actor: DISPATCHER });
  await cmd.attachBookingMember({ booking_id: "b1", member_id: "b", actor: DISPATCHER });
  await assert.rejects(() => cmd.attachBookingMember({ booking_id: "b1", member_id: "c", actor: DISPATCHER }), CapacityExceeded);
  cmd.detachBookingMember({ booking_id: "b1", member_id: "a", reason: "换房", actor: DISPATCHER });
  const b = Projection.build(store).bookings.get("b1");
  assert.deepEqual(b.members, ["b"]);
  assert.equal(b.history.length, 4);
});

// ================= 授权与最小化 =================
test("跨境资格只接受有权来源，旅行社确认被拒", () => {
  const { cmd } = harness();
  seedGroup(cmd);
  seedMember(cmd, "a");
  assert.throws(
    () => cmd.confirmEligibility({ member_id: "a", authority: "port_entry", valid_until: "2026-12-31", source: AGENT, actor: {} }),
    /只接受来源 port_authority/,
  );
  cmd.confirmEligibility({ member_id: "a", authority: "port_entry", valid_until: "2026-12-31", source: PORT, actor: {}, document_ref: "D" });
  const { store } = harnessStore(cmd);
  assert.equal(Projection.build(store).eligibility.get("a").state, "confirmed");
});

function harnessStore(cmd) {
  return { store: cmd.store };
}

test("领队只能维护本方成员", () => {
  const { cmd } = harness();
  seedGroup(cmd);
  seedMember(cmd, "a", { side: "domestic" });
  assert.throws(() => cmd.updateMember({ member_id: "a", changes: { dietary: "素" }, actor: L_RU }), /foreign 方领队无权修改 domestic 方/);
  cmd.updateMember({ member_id: "a", changes: { dietary: "素" }, actor: L_CN });
});

test("同名消歧要求成员确实同名，并为每人留痕", () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  seedMember(cmd, "a", { name: "王磊" });
  seedMember(cmd, "b", { name: "王磊" });
  seedMember(cmd, "c", { name: "李明" });
  assert.throws(() => cmd.disambiguate({ member_ids: ["a", "c"], resolution: {}, actor: L_CN }), /同名/);
  cmd.disambiguate({ member_ids: ["a", "b"], resolution: { a: "海拉尔", b: "满洲里" }, actor: L_CN });
  const p = Projection.build(store);
  assert.equal(p.members.get("a").disambiguation.note, "海拉尔");
  assert.equal(p.members.get("b").disambiguation.note, "满洲里");
});

test("导出按用途最小化：酒店名单不含保险、电话、证件句柄", () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  seedMember(cmd, "a");
  cmd.confirmEligibility({ member_id: "a", authority: "port_entry", valid_until: "2026-12-31", source: PORT, actor: {}, document_ref: "SECRET-REF" });
  const ledger = new ExportLedger(store, { now: () => new Date("2026-10-01T08:00:00+08:00") });
  const out = ledger.issue({
    group_id: "g1",
    recipient: { id: "h", name: "酒店" },
    purpose: "hotel_checkin",
    actor: DISPATCHER,
  });
  assert.equal(out.rows.length, 1);
  for (const forbidden of ["insurance", "phone", "emergency_contact", "document_ref"]) {
    assert.ok(!(forbidden in out.rows[0]), `${forbidden} 不得外发`);
  }
});

test("未登记用途拒绝导出", () => {
  assert.throws(() => redact({ a: 1 }, "unknown_purpose"), /未登记的导出用途/);
});

// ================= 口岸限流分批 =================
test("限流时按团队关系分批顺延，成员一个不少、行程不删除", async () => {
  const { store, cmd } = harness();
  seedGroup(cmd, "g1", "trade_fair");
  cmd.defineTeam({ group_id: "g1", team_id: "t1", team_name: "一组", actor: DISPATCHER });
  cmd.defineTeam({ group_id: "g1", team_id: "t2", team_name: "二组", actor: DISPATCHER });
  for (const id of ["a1", "a2", "b1", "b2", "b3"]) {
    seedMember(cmd, id, { team_id: id.startsWith("a") ? "t1" : "t2" });
  }
  cmd.defineSlot({ slot_id: "s1", port_code: "P", direction: "inbound", start_at: "2026-10-02T09:00:00+08:00", capacity: 4, source: PORT, actor: DISPATCHER });
  cmd.defineSlot({ slot_id: "s2", port_code: "P", direction: "inbound", start_at: "2026-10-02T11:00:00+08:00", capacity: 4, source: PORT, actor: DISPATCHER });
  cmd.changeSlotCapacity({ slot_id: "s1", new_capacity: 2, reason: "限流", source: PORT, actor: DISPATCHER });

  const plan = cmd.proposeBatches({ group_id: "g1", slot_id: "s1", plan_id: "p1", actor: DISPATCHER });
  const batches = plan.payload.batches;
  const allMembers = batches.flatMap((b) => b.member_ids);
  assert.deepEqual(new Set(allMembers), new Set(["a1", "a2", "b1", "b2", "b3"]));
  // t1 两人整体在第一批 s1，t2 整体顺延 s2（未被拆散）
  assert.deepEqual(batches[0].member_ids.sort(), ["a1", "a2"]);
  assert.equal(batches[0].slot_id, "s1");
  assert.deepEqual(batches.find((b) => b.slot_id === "s2").member_ids.sort(), ["b1", "b2", "b3"]);

  await cmd.acceptBatchPlan({ group_id: "g1", plan_id: "p1", actor: DISPATCHER });
  const p = Projection.build(store);
  assert.equal(p.slotUsed("s1"), 2);
  assert.equal(p.slotUsed("s2"), 3);
  // 改约留痕而非删除
  cmd.rescheduleGroup({ group_id: "g1", from_slot_id: "s1", to_slot_id: "s2", reason: "口岸通知", actor: DISPATCHER });
  assert.equal(Projection.build(store).groups.get("g1").reschedules.length, 1);
});

test("确认方案时容量复核：超出时段容量直接拒绝", async () => {
  const { cmd } = harness();
  seedGroup(cmd, "g1", "trade_fair");
  cmd.defineTeam({ group_id: "g1", team_id: "t1", team_name: "一组", actor: DISPATCHER });
  seedMember(cmd, "a1", { team_id: "t1" });
  cmd.defineSlot({ slot_id: "s1", port_code: "P", direction: "inbound", start_at: "2026-10-02T09:00:00+08:00", capacity: 1, source: PORT, actor: DISPATCHER });
  cmd.defineSlot({ slot_id: "s2", port_code: "P", direction: "inbound", start_at: "2026-10-02T11:00:00+08:00", capacity: 1, source: PORT, actor: DISPATCHER });
  cmd.proposeBatches({ group_id: "g1", slot_id: "s1", plan_id: "p1", actor: DISPATCHER });
  // 他团先占 s1
  cmd.createGroup({ group_id: "g2", activity_kind: "trade_fair", name: "他团", actor: DISPATCHER });
  cmd.store.append({
    event_type: "CROSSING_ASSIGNED", aggregate_type: "crossing_slot", aggregate_id: "s1",
    summary: "占用", payload: { slot_id: "s1", group_id: "g2", member_count: 1, batch_no: 1 },
  });
  await assert.rejects(() => cmd.acceptBatchPlan({ group_id: "g1", plan_id: "p1", actor: DISPATCHER }), CapacityExceeded);
});

// ================= 合同版本与取消责任 =================
test("取消责任按变更时点适用当时有效的合同版本", () => {
  const versions = new Map([
    [1, { agreed_at: "2026-09-01T00:00:00+08:00", cancel_tiers: [{ before_hours: 336, fee_pct: 0 }], no_show_pct: 100 }],
    [2, { agreed_at: "2026-09-20T00:00:00+08:00", cancel_tiers: [{ before_hours: 168, fee_pct: 10 }, { before_hours: 48, fee_pct: 60 }], no_show_pct: 100 }],
  ]);
  const start = "2026-10-02T09:00:00+08:00";

  let v = decideCancellationLiability(versions, "2026-09-18T09:00:00+08:00", start);
  assert.equal(v.contractVersion, 1, "9/18 时 v2 未签订，适用 v1");
  assert.equal(v.fee_pct, 0);

  v = decideCancellationLiability(versions, "2026-09-30T08:00:00+08:00", start);
  assert.equal(v.contractVersion, 2);
  assert.equal(v.fee_pct, 60);

  v = decideCancellationLiability(versions, "2026-10-03T00:00:00+08:00", start);
  assert.equal(v.rule, "no_show");
  assert.equal(v.fee_pct, 100);
});

// ================= 到访结算 =================
test("结算只以口岸确认的实际到访为依据", () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  ["a", "b", "c"].forEach((id) => seedMember(cmd, id));
  cmd.agreeContract({
    contract_id: "ct", group_id: "g1", party: "商会", version: 1, actor: DISPATCHER,
    terms: { unit_price: 100, cancel_tiers: [], no_show_pct: 100 },
  });
  // 非授权来源不能录到访
  assert.throws(
    () => cmd.recordAttendance({ proof_id: "p_bad", group_id: "g1", member_id: "a", marker: "x", source: AGENT }),
    /口岸\/现场核验/,
  );
  cmd.recordAttendance({ proof_id: "p_a", group_id: "g1", member_id: "a", marker: "gate", source: PORT });
  cmd.recordAttendance({ proof_id: "p_b", group_id: "g1", member_id: "b", marker: "gate", source: PORT });
  const s = cmd.settleByAttendance({ settlement_id: "stl", group_id: "g1", contract_id: "ct", actor: DISPATCHER });
  assert.equal(s.payload.attended_count, 2);
  assert.equal(s.payload.amount, 200);
  assert.deepEqual(s.payload.member_ids.sort(), ["a", "b"]);
  assert.equal(Projection.build(store).settlement.basis, "actual_attendance");
});

// ================= 导出台账 =================
test("导出登记接收方/用途/失效时间，过期与吊销均可回验", () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  seedMember(cmd, "a");
  const ledger = new ExportLedger(store, { now: () => new Date("2026-10-01T08:00:00+08:00") });
  assert.throws(
    () => ledger.issue({ group_id: "g1", recipient: null, purpose: "hotel_checkin", actor: DISPATCHER }),
    /接收方/,
  );
  const out = ledger.issue({
    group_id: "g1",
    recipient: { id: "h", name: "酒店" },
    purpose: "hotel_checkin",
    ttl_hours: 24,
    actor: DISPATCHER,
  });
  assert.equal(out.expires_at, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(ledger.verify(out.export_id, "2026-10-02T07:00:00+08:00"), {
    valid: true,
    recipient: { id: "h", name: "酒店" },
    purpose: "hotel_checkin",
    fields: out.fields,
    record_count: 1,
    expires_at: out.expires_at,
  });
  assert.equal(ledger.verify(out.export_id, "2026-10-03T00:00:00+08:00").reason, "expired");
  ledger.revoke({ export_id: out.export_id, reason: "名单变更", actor: DISPATCHER });
  assert.equal(ledger.verify(out.export_id).reason, "revoked");
});

// ================= 双语清单 =================
test("中俄双语清单按方别过滤并完成本地化", () => {
  const { store, cmd } = harness();
  seedGroup(cmd);
  seedMember(cmd, "cn1", { side: "domestic", name: "张三" });
  seedMember(cmd, "ru1", { side: "foreign", name: "Иван" });
  const views = new Views(Projection.build(store));
  const roster = views.leaderRoster({ group_id: "g1", side: "foreign" });
  assert.equal(roster.ru.length, 1);
  assert.ok("ФИО" in roster.ru[0]);
  assert.equal(roster.ru[0]["Сторона"], "Россия");
  assert.equal(roster.zh[0]["方别"], "俄方");
  assert.ok(!("team_id" in roster.ru[0]), "内部键不外显");
});
