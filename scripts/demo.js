// 端到端演示：中俄合唱交流、体育大会、口岸贸易三个团组的一天。
// 运行：npm run demo
import { createSystem } from "../src/index.js";

const sys = createSystem({ now: () => "2026-10-04T09:00:00+08:00" });
const section = (title) => console.log(`\n=== ${title} ===`);

// ── 合同与团组 ──────────────────────────────────────────────
section("合同与团组");
sys.contracts.publish({
  contract_id: "c-hotel-2026",
  version: 1,
  partner_id: "hotel-aurora",
  program: "choir",
  price_per_member_cents: 80000,
  cancellation_tiers: [
    { min_hours_before: 72, fee_percent: 0 },
    { min_hours_before: 24, fee_percent: 50 },
    { min_hours_before: 0, fee_percent: 100 },
  ],
  effective_from: "2026-09-01T00:00:00+08:00",
});
sys.members.createGroup({ group_id: "g-choir", program: "choir", name_zh: "中俄合唱交流团", name_ru: "Китайско-российский хор", capacity: 3, contract_id: "c-hotel-2026", side: "cn" });
sys.members.createGroup({ group_id: "g-sports", program: "sports", name_zh: "体育大会团", name_ru: "Спортивная делегация", capacity: 4, side: "ru" });
sys.members.createGroup({ group_id: "g-trade", program: "trade", name_zh: "口岸贸易团", name_ru: "Торговая делегация", capacity: 4, side: "cn" });
console.log("团组：", [...sys.members.groups.values()].map((g) => `${g.name_zh}(${g.capacity})`).join("、"));

// ── 成员登记：容量、候补、同名消歧 ──────────────────────────
section("成员登记（合唱团圆员 3 人，第 4 人候补；两名“王磊”消歧）");
sys.members.registerMember({ group_id: "g-choir", member_id: "c1", person_id: "cn-001", name_zh: "王磊", name_ru: "Ван Лэй", role: "leader", birth_date: "1988-03-12", document_ref: "E12345678", languages: ["zh", "ru"], insurance: { policy_ref: "POL-1", insurer: "平安", valid_until: "2026-12-31" }, emergency_contact: { name: "王芳", phone: "138****0000", relation: "配偶" } });
sys.members.registerMember({ group_id: "g-choir", member_id: "c2", person_id: "ru-002", name_zh: "安娜", name_ru: "Анна", languages: ["ru", "zh"], insurance: { policy_ref: "POL-2", insurer: "Ресо", valid_until: "2026-12-31" }, emergency_contact: { name: "Иван", phone: "+7 900 ***", relation: "兄弟" } });
sys.members.registerMember({ group_id: "g-choir", member_id: "c3", person_id: "cn-003", name_zh: "李雪", name_ru: "Ли Сюэ", languages: ["zh"], insurance: { policy_ref: "POL-3", insurer: "平安", valid_until: "2026-12-31" }, emergency_contact: { name: "李强", phone: "139****0000", relation: "父亲" } });
const c4 = sys.members.registerMember({ group_id: "g-choir", member_id: "c4", person_id: "cn-004", name_zh: "王磊", birth_date: "1995-07-01", document_ref: "E87654321", languages: ["zh"] });
console.log(`c4 状态：${c4.status}（候补第 ${c4.waitlist_position} 位）`);
console.log("同名“王磊”消歧：", JSON.stringify(sys.members.disambiguate("g-choir", "王磊")));
for (const [gid, ids] of [["g-sports", ["s1", "s2", "s3"]], ["g-trade", ["t1", "t2"]]]) {
  ids.forEach((id, i) => sys.members.registerMember({ group_id: gid, member_id: id, person_id: `p-${id}`, name_zh: `成员${id}`, role: i === 0 ? "leader" : "member" }));
}

// ── 跨境资格：只接受有权来源 ────────────────────────────────
section("跨境资格确认");
sys.eligibility.registerSource({ source_id: "port-authority", authority: "口岸边防检查站", kinds: ["cross_border"], programs: ["choir", "sports", "trade"] });
try {
  sys.eligibility.confirm({ member_id: "c1", program: "choir", kind: "cross_border", source_id: "travel-agency" });
} catch (e) {
  console.log(`旅行社试图确认资格 → 拒绝：${e.message}`);
}
for (const id of ["c1", "c2", "c3", "s1", "s2", "s3", "t1", "t2"]) {
  const program = sys.members.get(id).group_id === "g-choir" ? "choir" : sys.members.get(id).group_id === "g-sports" ? "sports" : "trade";
  sys.eligibility.confirm({ member_id: id, program, kind: "cross_border", source_id: "port-authority" });
}
console.log("口岸边防已确认 8 名成员资格（事件只记录状态与来源，不含证件号）");

// ── 资源预订：拼房、同车、并发防超售 ────────────────────────
section("资源预订");
sys.inventory.registerResource({ resource_id: "room-301", kind: "room", capacity: 2, label: "标间 301" });
sys.inventory.registerResource({ resource_id: "bus-a", kind: "vehicle", capacity: 3, label: "大巴 A" });
sys.inventory.registerResource({ resource_id: "seat-choir", kind: "seat", capacity: 60, label: "演出席位-合唱场" });
sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h-room-1", member_ids: ["c1", "c2"] });
console.log("拼房：c1+c2 共用标间 301，占用", sys.inventory.occupancy("room-301"));
const v0 = sys.store.versionOf("inventory_resource", "bus-a");
sys.inventory.placeHold({ resource_id: "bus-a", hold_id: "h-bus-1", member_ids: ["c1", "c2"], expected_version: v0 });
try {
  sys.inventory.placeHold({ resource_id: "bus-a", hold_id: "h-bus-2", member_ids: ["c3"], expected_version: v0 });
} catch (e) {
  console.log(`并发抢座（过期版本）→ ${e.name}：${e.message}`);
}
sys.inventory.placeHold({ resource_id: "bus-a", hold_id: "h-bus-2", member_ids: ["c3"], expected_version: sys.store.versionOf("inventory_resource", "bus-a") });
sys.inventory.placeHold({ resource_id: "seat-choir", hold_id: "h-seat-1", member_ids: ["c1", "c2", "c3"] });
console.log("大巴 A 占用", sys.inventory.occupancy("bus-a"), "/ 3；合唱席位占用", sys.inventory.occupancy("seat-choir"), "/ 60");

// ── 口岸限流：分批方案而不是删除行程 ────────────────────────
section("口岸临时限流");
sys.crossing.publishSlot({ slot_id: "slot-1", port: "珲春口岸", start: "2026-10-06T08:00:00+08:00", end: "2026-10-06T12:00:00+08:00", capacity: 10 });
for (const gid of ["g-choir", "g-sports", "g-trade"]) sys.crossing.assignGroup({ slot_id: "slot-1", group_id: gid });
sys.crossing.restrict({ slot_id: "slot-1", new_capacity: 4, reason: "车道检修" });
const proposal = sys.crossing.proposeBatching({ slot_id: "slot-1" });
const local = (iso) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(11, 16);
for (const batch of proposal.batches) {
  console.log(`第 ${batch.batch_no} 批 ${local(batch.window.start)}–${local(batch.window.end)}：${batch.groups.map((g) => `${g.group_id}(${g.member_ids.length}人)`).join(" + ")}`);
}

// ── 成员退出：取消责任 + 候补转正 ───────────────────────────
section("成员退出（活动前 25 小时）");
sys.clock.set("2026-10-05T09:00:00+08:00");
const { assessment, promotion } = sys.withdrawMember("c2", { reason: "突发疾病", activity_id: "act-gala", activity_start: "2026-10-06T10:00:00+08:00" });
console.log(`取消责任：合同 v${assessment.payload.contract_version}，提前 ${assessment.payload.hours_before} 小时，费率 ${assessment.payload.fee_percent}%，费用 ${assessment.payload.fee_cents / 100} 元`);
console.log(`候补转正：${promotion.aggregate_id}（${promotion.summary}）`);

// ── 实际到访与结算 ──────────────────────────────────────────
section("活动日到访与结算");
sys.clock.set("2026-10-06T10:10:00+08:00");
for (const id of ["c1", "c3", "c4"]) {
  sys.settlement.recordAttendance({ member_id: id, activity_id: "act-gala", arrived_at: "2026-10-06T09:5" + (id === "c1" ? "0" : "5") + ":00+08:00" });
}
const result = sys.settlement.computeSettlement({ group: sys.members.getGroup("g-choir"), activity_id: "act-gala", activity_start: "2026-10-06T10:00:00+08:00" });
console.log(`结算：实际到访 ${result.payload.attended_count} 人 × 800 元 + 取消费 ${result.payload.cancellation_fee_cents / 100} 元 = ${result.payload.total_cents / 100} 元`);

// ── 双语清单与导出登记 ──────────────────────────────────────
section("双语清单与导出登记");
const leader = sys.exports.issue({ group_id: "g-choir", audience: "leader", recipient: "俄方领队 Анна", purpose: "行前核对", ttl_seconds: 86400 });
console.log(leader.table);
const hotel = sys.exports.issue({ group_id: "g-choir", audience: "partner_hotel", recipient: "极光酒店前台", purpose: "入住登记", ttl_seconds: 86400 });
console.log("\n酒店清单（无证件、无紧急联系人）：");
console.log(hotel.table);
console.log("\n导出日志：", sys.store.ofType("EXPORT_ISSUED").map((e) => `${e.payload.export_id} → ${e.payload.recipient}（${e.payload.purpose}，失效 ${e.payload.expires_at}）`).join("；"));
sys.clock.set("2026-10-08T09:00:00+08:00");
try {
  sys.exports.assertValid(leader.record.export_id);
} catch (e) {
  console.log(`10-08 使用过期导出 → 拒绝：${e.message}`);
}

// ── 调度员风险总览 ──────────────────────────────────────────
section("调度员风险总览");
sys.clock.set("2026-10-05T12:00:00+08:00");
for (const [gid, findings] of Object.entries(sys.risk.overview({ activity_start: "2026-10-06T10:00:00+08:00" }))) {
  console.log(`${gid}：${findings.length} 项`);
  for (const f of findings.slice(0, 4)) console.log(`  [${f.severity}] ${f.message_zh} / ${f.message_ru}`);
}

console.log(`\n事件总量：${sys.store.all().length} 条，全部留痕可追溯`);
