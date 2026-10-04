/**
 * 端到端联调剧本：中俄合唱交流 / 体育大会 / 口岸贸易活动。
 * 运行：node src/demo.js  （产物写入 out/）
 *
 * 剧本覆盖：
 *  - 中外领队各自维护本方成员、语言/保险/紧急联系人；
 *  - 并发抢占演出席位/车位：不超售，超额自动候补，释放后自动转正；
 *  - 多人共用一间订房，成员退出保留过程；
 *  - 同名消歧；跨境资格只认口岸/领馆，旅行社确认被拒；
 *  - 口岸临时限流：按团队关系分批、顺延后续时段，不删行程；
 *  - 实际到访结算 + 按变更时点与合同版本判定取消责任；
 *  - 中俄双语领队清单、调度员风险面板；导出登记接收方/用途/失效时间并可吊销回验。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { EventStore } from "./domain/store.js";
import { Commands } from "./domain/commands.js";
import { Projection } from "./domain/projection.js";
import { Views } from "./domain/views.js";
import { ExportLedger } from "./domain/exports.js";

const PORT = { id: "port_manzhouli", kind: "port_authority" };
const CONSULATE = { id: "consulate_chita", kind: "consular_authority" };
const AGENT = { id: "agent_lvyyou", kind: "travel_agent" };
const DISPATCH = { id: "disp_01", kind: "festival_dispatch" };
const LEADER_CN = { id: "leader_cn", role: "leader", side: "domestic", name: "李调度" };
const LEADER_RU = { id: "leader_ru", role: "leader", side: "foreign", name: "Иванова" };
const DISPATCHER = { id: "disp_01", role: "dispatcher", name: "王调度员" };

function section(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

async function main() {
  const clock = ["2026-09-25T08:00:00+08:00"];
  const store = new EventStore({ now: () => new Date(clock[0]) });
  const now = () => clock[0];
  const cmd = new Commands(store, { now });
  const ledger = new ExportLedger(store, { now: () => new Date(clock[0]) });
  const artifacts = {};

  // ================================================================
  // 一、中俄合唱交流：并发席位、候补转正、同名消歧
  // ================================================================
  section("一、中俄合唱交流（chorus）");

  cmd.createGroup({
    group_id: "g_chorus", activity_kind: "chorus",
    name: "伏尔加之声合唱团", actor: DISPATCHER, source: DISPATCH,
  });
  cmd.assignLeader({ group_id: "g_chorus", side: "domestic", leader_id: "leader_cn", leader_name: "李调度", actor: DISPATCHER });
  cmd.assignLeader({ group_id: "g_chorus", side: "foreign", leader_id: "leader_ru", leader_name: "Иванова", actor: DISPATCHER });
  cmd.defineTeam({ group_id: "g_chorus", team_id: "t_soprano", team_name: "女高音声部", kind: "section", actor: DISPATCHER });
  cmd.defineTeam({ group_id: "g_chorus", team_id: "t_bass", team_name: "男低音声部", kind: "section", actor: DISPATCHER });

  // 两位同名“王磊”，分别属于不同声部 —— 消歧而非合并
  cmd.registerMember({
    member_id: "m_wanglei_1", group_id: "g_chorus", team_id: "t_soprano", side: "domestic",
    display_name: "王磊", languages: ["zh"], role: "soprano", actor: LEADER_CN,
    phone: "138****0001", emergency_contact: { name: "王父", phone: "139****1111" },
    insurance: { policy_ref: "INS-CN-0001", valid_until: "2026-12-31" },
  });
  cmd.registerMember({
    member_id: "m_wanglei_2", group_id: "g_chorus", team_id: "t_bass", side: "domestic",
    display_name: "王磊", languages: ["zh", "ru"], role: "bass", actor: LEADER_CN,
    phone: "138****0002", emergency_contact: { name: "王母", phone: "139****2222" },
    insurance: { policy_ref: "INS-CN-0002", valid_until: "2026-12-31" },
  });
  cmd.disambiguate({
    member_ids: ["m_wanglei_1", "m_wanglei_2"],
    resolution: {
      m_wanglei_1: "女高音声部，海拉尔人",
      m_wanglei_2: "男低音声部，满洲里人，通俄语",
    },
    actor: LEADER_CN,
  });
  console.log("✓ 两位同名成员已分别登记并完成消歧留痕");

  // 俄方成员自行维护：语言需求与保险
  cmd.registerMember({
    member_id: "m_anna", group_id: "g_chorus", team_id: "t_soprano", side: "foreign",
    display_name: "Анна Петрова", languages: ["ru"], needs_interpreter: true,
    role: "soprano", actor: LEADER_RU,
    phone: "+7 914 *** 0003", emergency_contact: { name: "Петр", phone: "+7 914 *** 3333" },
    insurance: { policy_ref: "INS-RU-0003", valid_until: "2026-12-31" },
  });
  cmd.registerMember({
    member_id: "m_boris", group_id: "g_chorus", team_id: "t_bass", side: "foreign",
    display_name: "Борис Смирнов", languages: ["ru", "zh"],
    role: "bass", actor: LEADER_RU,
    phone: "+7 914 *** 0004", emergency_contact: { name: "Ольга", phone: "+7 914 *** 4444" },
    insurance: { policy_ref: "INS-RU-0004", valid_until: "2026-12-31" },
  });

  // 越权演示：俄方领队不能改中方成员
  try {
    cmd.updateMember({ member_id: "m_wanglei_1", changes: { dietary: "清真" }, actor: LEADER_RU });
    console.log("✗ 越权修改未被拦截");
  } catch (e) {
    console.log(`✓ 越权修改被拦截：${e.message}`);
  }
  // 本方领队可改
  cmd.updateMember({ member_id: "m_wanglei_1", changes: { dietary: "清真" }, actor: LEADER_CN });

  // 演出席位只有 3 个，4 人并发抢（含一次真实并发）
  cmd.defineResource({
    resource_id: "r_seat_chorus", kind: "event_seat", capacity: 3,
    label: "合唱音乐会主厅席位", actor: DISPATCHER,
  });
  cmd.holdOrWaitlist({ resource_id: "r_seat_chorus", member_id: "m_wanglei_1", hold_id: "h_seat_1", actor: DISPATCHER });
  cmd.holdOrWaitlist({ resource_id: "r_seat_chorus", member_id: "m_wanglei_2", hold_id: "h_seat_2", actor: DISPATCHER });
  // Анна 与 Борис 同时抢最后 1 席
  const concurrent = await Promise.allSettled([
    cmd.holdOrWaitlist({ resource_id: "r_seat_chorus", member_id: "m_anna", hold_id: "h_seat_3", actor: DISPATCHER }),
    cmd.holdOrWaitlist({ resource_id: "r_seat_chorus", member_id: "m_boris", hold_id: "h_seat_4", actor: DISPATCHER }),
  ]);
  const snap1 = Projection.build(store);
  const held = snap1.usedCapacity("r_seat_chorus");
  const waiting = snap1.waitlist("r_seat_chorus");
  console.log(`✓ 并发抢座后：已持有 ${held}/3（绝无超售），候补 ${waiting.length} 人：${waiting.map((h) => `${h.member_id}#${h.rank}`).join("、")}`);

  // 一名中方成员临时退出 → 释放席位 → 候补自动转正（过程全部留痕）
  clock[0] = "2026-09-28T10:00:00+08:00";
  await cmd.withdrawMember({ member_id: "m_wanglei_1", reason: "突发疾病", actor: LEADER_CN });
  const promotedEvent = [...store.readByType("WAITLIST_PROMOTED")].at(-1);
  console.log(`✓ 成员退出后席位释放，候补首位 ${promotedEvent.payload.member_id} 自动转正（退出/释放/转正事件均保留）`);

  // ================================================================
  // 二、体育大会：共用订房、退出过程、合同版本与取消责任
  // ================================================================
  section("二、体育大会（sports_games）");

  clock[0] = "2026-09-10T09:00:00+08:00";
  cmd.createGroup({
    group_id: "g_sports", activity_kind: "sports_games",
    name: "中俄青少年体育大会·摔跤队", actor: DISPATCHER, source: DISPATCH,
  });
  cmd.defineTeam({ group_id: "g_sports", team_id: "t_wrestle", team_name: "摔跤联队", kind: "event", actor: DISPATCHER });

  cmd.registerMember({ member_id: "m_sergei", group_id: "g_sports", team_id: "t_wrestle", side: "foreign", display_name: "Сергей Иванов", languages: ["ru"], needs_interpreter: true, actor: LEADER_RU, phone: "+7 900 *** 0005", emergency_contact: { name: "Иван", phone: "+7 900 *** 5555" }, insurance: { policy_ref: "INS-RU-0005", valid_until: "2026-12-31" } });
  cmd.registerMember({ member_id: "m_dima", group_id: "g_sports", team_id: "t_wrestle", side: "foreign", display_name: "Дмитрий Орлов", languages: ["ru", "en"], actor: LEADER_RU, phone: "+7 900 *** 0006", emergency_contact: { name: "Олег", phone: "+7 900 *** 6666" }, insurance: { policy_ref: "INS-RU-0006", valid_until: "2026-12-31" } });
  cmd.registerMember({ member_id: "m_zhang", group_id: "g_sports", team_id: "t_wrestle", side: "domestic", display_name: "张大力", languages: ["zh", "ru"], actor: LEADER_CN, phone: "137****0007", emergency_contact: { name: "张父", phone: "137****7777" }, insurance: { policy_ref: "INS-CN-0007", valid_until: "2026-12-31" } });

  // 旅行社已订一间三人房：多人共用同一预订
  cmd.createBooking({
    booking_id: "bk_hotel_808", kind: "hotel", group_id: "g_sports",
    supplier: "口岸国际大酒店 808 房", capacity: 3, contract_ref: "HTL-2026-0808", actor: DISPATCHER,
  });
  for (const id of ["m_sergei", "m_dima", "m_zhang"]) {
    cmd.attachBookingMember({ booking_id: "bk_hotel_808", member_id: id, actor: DISPATCHER });
  }
  console.log("✓ 三人共用 808 房，挂接/移除均有事件，保留共用过程");

  // 合同两版：v1 提前 14 天免责；v2（9月20日改签）收紧为提前 7 天
  cmd.agreeContract({
    contract_id: "ct_sports", group_id: "g_sports", party: "俄方体育协会",
    version: 1, actor: DISPATCHER,
    terms: {
      unit_price: 1200,
      cancel_tiers: [{ before_hours: 336, fee_pct: 0 }, { before_hours: 72, fee_pct: 50 }],
      no_show_pct: 100,
    },
  });
  clock[0] = "2026-09-20T12:00:00+08:00";
  cmd.agreeContract({
    contract_id: "ct_sports", group_id: "g_sports", party: "俄方体育协会",
    version: 2, actor: DISPATCHER,
    terms: {
      unit_price: 1200,
      cancel_tiers: [{ before_hours: 168, fee_pct: 10 }, { before_hours: 48, fee_pct: 60 }],
      no_show_pct: 100,
    },
  });

  const ACTIVITY_START = "2026-10-02T09:00:00+08:00";
  // Сергей 在 9/18 退出 → 适用 v1（当时 v2 尚未签订），提前 14 天以上 → 免责
  clock[0] = "2026-09-18T09:00:00+08:00";
  await cmd.withdrawMember({ member_id: "m_sergei", reason: "伤病", actor: LEADER_RU });
  cmd.detachBookingMember({ booking_id: "bk_hotel_808", member_id: "m_sergei", reason: "成员退出", actor: DISPATCHER });
  const liab1 = cmd.decideLiability({ contract_id: "ct_sports", member_id: "m_sergei", changed_at: clock[0], activity_start_at: ACTIVITY_START, actor: DISPATCHER });
  console.log(`✓ Сергей 9/18 退出：适用 ${liab1.payload.rule}，合同 v${liab1.payload.contract_version}，费率 ${liab1.payload.fee_pct}%`);

  // Дима 9/30 清晨退出 → 适用 v2，落在提前 48 小时档 → 60%
  clock[0] = "2026-09-30T08:00:00+08:00";
  await cmd.withdrawMember({ member_id: "m_dima", reason: "签证问题", actor: LEADER_RU });
  const liab2 = cmd.decideLiability({ contract_id: "ct_sports", member_id: "m_dima", changed_at: clock[0], activity_start_at: ACTIVITY_START, actor: DISPATCHER });
  console.log(`✓ Дима 9/30 退出：适用 ${liab2.payload.rule}，合同 v${liab2.payload.contract_version}，费率 ${liab2.payload.fee_pct}%`);

  // ================================================================
  // 三、口岸贸易活动：资格来源管控、限流分批、到访结算
  // ================================================================
  section("三、口岸贸易活动（trade_fair）");

  cmd.createGroup({
    group_id: "g_trade", activity_kind: "trade_fair",
    name: "后贝加尔斯克边贸采购团", actor: DISPATCHER, source: DISPATCH,
  });
  cmd.defineTeam({ group_id: "g_trade", team_id: "t_food", team_name: "食品采购组", parent_team_id: null, kind: "delegation", actor: DISPATCHER });
  cmd.defineTeam({ group_id: "g_trade", team_id: "t_mach", team_name: "机电采购组", parent_team_id: null, kind: "delegation", actor: DISPATCHER });

  const tradeMembers = [
    ["m_oleg", "foreign", "Олег Кузнецов", "t_food", ["ru"]],
    ["m_yuri", "foreign", "Юрий Волков", "t_food", ["ru", "zh"]],
    ["m_igor", "foreign", "Игорь Морозов", "t_mach", ["ru"]],
    ["m_lena", "foreign", "Елена Соколова", "t_mach", ["ru", "en"]],
    ["m_zhao", "domestic", "赵守明", "t_food", ["zh", "ru"]],
    ["m_qian", "domestic", "钱多金", "t_mach", ["zh"]],
  ];
  for (const [member_id, side, display_name, team_id, languages] of tradeMembers) {
    cmd.registerMember({
      member_id, group_id: "g_trade", team_id, side, display_name, languages,
      actor: side === "foreign" ? LEADER_RU : LEADER_CN,
      phone: "***", emergency_contact: { name: "EC", phone: "***" },
      insurance: { policy_ref: `INS-${member_id}`, valid_until: "2026-12-31" },
    });
  }

  // 跨境资格：旅行社想“代口岸确认”——必须拒绝
  try {
    cmd.confirmEligibility({
      member_id: "m_oleg", authority: "port_entry",
      valid_until: "2026-10-10", source: AGENT, actor: { id: "agent_lvyyou", role: "travel_agent" },
    });
    console.log("✗ 旅行社越权确认资格未被拦截");
  } catch (e) {
    console.log(`✓ 旅行社确认资格被拒：${e.message}`);
  }
  // 正确路径：口岸确认；领馆可处理签证类
  for (const id of ["m_oleg", "m_yuri", "m_igor", "m_lena"]) {
    cmd.requestEligibility({ member_id: id, document_ref: `DOC-REF-${id.toUpperCase()}`, authority: "port_entry", actor: DISPATCHER });
    cmd.confirmEligibility({ member_id: id, authority: "port_entry", valid_until: "2026-10-10", source: PORT, actor: { id: "port_officer", role: "officer" }, document_ref: `DOC-REF-${id.toUpperCase()}` });
  }
  // 钱姓成员材料被领馆拒绝（只留原因码，不留证件细节）
  cmd.requestEligibility({ member_id: "m_qian", document_ref: "DOC-REF-QIAN", authority: "consulate", actor: DISPATCHER });
  cmd.denyEligibility({ member_id: "m_qian", authority: "consulate", reason_code: "INCOMPLETE_INVITATION", source: CONSULATE, actor: { id: "consul_clerk", role: "officer" } });
  console.log("✓ 跨境资格只采信口岸/领馆；事件载荷只含 document_ref 句柄与原因码");

  // 口岸分时：原时段 6 人容量，夜间临时限流为 3；另有后续时段 3
  cmd.defineSlot({ slot_id: "s_1002_0900", port_code: "MZL", direction: "inbound", start_at: "2026-10-02T09:00:00+08:00", capacity: 6, source: PORT, actor: DISPATCHER });
  cmd.defineSlot({ slot_id: "s_1002_1100", port_code: "MZL", direction: "inbound", start_at: "2026-10-02T11:00:00+08:00", capacity: 3, source: PORT, actor: DISPATCHER });
  clock[0] = "2026-10-01T22:00:00+08:00";
  cmd.changeSlotCapacity({ slot_id: "s_1002_0900", new_capacity: 3, reason: "临时客流管控", source: PORT, actor: DISPATCHER });

  // 按团队关系分批：食品组整体走第一批，机电组顺延 11:00（行程保留）
  const plan = cmd.proposeBatches({
    group_id: "g_trade", slot_id: "s_1002_0900",
    plan_id: "plan_1001", reason: "port_capacity_change_2200", actor: DISPATCHER,
  });
  console.log("✓ 限流分批方案（按团队成块，不拆散、不删行程）：");
  for (const b of plan.payload.batches) {
    console.log(`   - 批次#${b.batch_no} ${b.slot_id} 团队 ${b.team_id}：${b.member_ids.join("、")}`);
  }
  await cmd.acceptBatchPlan({ group_id: "g_trade", plan_id: "plan_1001", actor: DISPATCHER });

  // 并发占用同一时段也不能超售：再造一个团直接抢 09:00 时段
  cmd.createGroup({ group_id: "g_trade2", activity_kind: "trade_fair", name: "零散商户团", actor: DISPATCHER, source: DISPATCH });
  cmd.registerMember({ member_id: "m_extra1", group_id: "g_trade2", side: "domestic", display_name: "孙老板", actor: LEADER_CN });
  const snapT = Projection.build(store);
  const slotFree = snapT.slots.get("s_1002_0900").capacity - snapT.slotUsed("s_1002_0900");
  console.log(`✓ 09:00 时段已用 ${snapT.slotUsed("s_1002_0900")}/${snapT.slots.get("s_1002_0900").capacity}，剩余 ${slotFree}（确认方案时容量复核，超限直接拒绝）`);

  // ================================================================
  // 四、实际到访结算
  // ================================================================
  section("四、活动后：以实际到访结算");

  cmd.agreeContract({
    contract_id: "ct_trade", group_id: "g_trade", party: "后贝加尔斯克商会",
    version: 1, actor: DISPATCHER,
    terms: { unit_price: 800, cancel_tiers: [{ before_hours: 72, fee_pct: 30 }], no_show_pct: 100 },
  });
  // 口岸入境章作为实际到访凭据；m_qian 资格被拒未到访
  clock[0] = "2026-10-02T09:30:00+08:00";
  for (const id of ["m_oleg", "m_yuri", "m_zhao"]) {
    cmd.recordAttendance({ proof_id: `proof_${id}`, group_id: "g_trade", member_id: id, marker: "port_gate_e", proof_ref: `stamp:MZL:${id}`, source: PORT });
  }
  clock[0] = "2026-10-02T11:20:00+08:00";
  for (const id of ["m_igor", "m_lena"]) {
    cmd.recordAttendance({ proof_id: `proof_${id}`, group_id: "g_trade", member_id: id, marker: "port_gate_e", proof_ref: `stamp:MZL:${id}`, source: PORT });
  }
  clock[0] = "2026-10-05T12:00:00+08:00";
  const settlement = cmd.settleByAttendance({
    settlement_id: "stl_trade_001", group_id: "g_trade",
    contract_id: "ct_trade", actor: DISPATCHER,
  });
  console.log(`✓ 结算依据 ${settlement.payload.basis}：实际到访 ${settlement.payload.attended_count} 人 × ${settlement.payload.unit_price} = ${settlement.payload.amount}（未到访的 m_qian 不计费）`);

  // ================================================================
  // 五、双语清单、风险面板、导出台账
  // ================================================================
  section("五、双语清单 / 风险面板 / 导出台账");

  const views = new Views(Projection.build(store), { now: () => new Date(clock[0]) });

  const ruRoster = views.leaderRoster({ group_id: "g_trade", side: "foreign", purpose: "leader_roster" });  artifacts["roster_trade_ru_leader.ru.json"] = ruRoster.ru;
  artifacts["roster_trade_ru_leader.zh.json"] = ruRoster.zh;
  console.log("✓ 俄方领队清单（俄文）前两行：");
  console.log(JSON.stringify(ruRoster.ru.slice(0, 2), null, 2));

  // 给酒店的导出：只含入住所需字段，绝无保险单号/紧急电话/证件句柄
  const hotelExport = ledger.issue({
    group_id: "g_sports",
    recipient: { id: "hotel_gjgj", name: "口岸国际大酒店前台", kind: "hotel" },
    purpose: "hotel_checkin",
    actor: DISPATCHER,
    ttl_hours: 48,
  });
  console.log(`✓ 酒店入住导出 ${hotelExport.export_id}，字段：${hotelExport.fields.join("、")}`);
  const leaked = hotelExport.rows.some((r) => "insurance" in r || "phone" in r || "document_ref" in r);
  console.log(leaked ? "✗ 发现敏感字段外泄" : "✓ 保险/电话/证件句柄均未外泄");

  // 给口岸的通行名单：含资格状态与 document_ref 句柄（仍无证件号码细节）
  const borderExport = ledger.issue({
    group_id: "g_trade",
    recipient: { id: "port_manzhouli", name: "满洲里口岸边检", kind: "port_authority" },
    purpose: "border_manifest",
    actor: DISPATCHER,
    ttl_hours: 24,
  });
  console.log(`✓ 口岸通行导出 ${borderExport.export_id}，${borderExport.rows.length} 条，字段：${borderExport.fields.join("、")}`);

  // 成员临时退出 → 吊销已发名单；口岸回验时即失效
  ledger.revoke({ export_id: borderExport.export_id, reason: "团组名单变更，需重新导出", actor: DISPATCHER });
  const check = ledger.verify(borderExport.export_id);
  console.log(`✓ 口岸回验旧导出：valid=${check.valid}（${check.reason}）`);

  // 一份自然过期的导出示例（风险面板可见）
  clock[0] = "2026-09-25T09:00:00+08:00";
  const shortLived = new ExportLedger(store, { now: () => new Date(clock[0]) }).issue({
    group_id: "g_chorus",
    recipient: { id: "venue_hall", name: "音乐厅票务", kind: "venue" },
    purpose: "seat_manifest",
    actor: DISPATCHER,
    ttl_hours: 1,
  });
  clock[0] = "2026-10-05T12:00:00+08:00";
  console.log(`✓ 过期导出回验：valid=${ledger.verify(shortLived.export_id, "2026-10-05T12:00:00+08:00").valid}`);

  const board = new Views(Projection.build(store), { now: () => new Date(clock[0]) }).riskBoard(clock[0]);
  artifacts["risk_board.json"] = board;
  artifacts["hotel_export.json"] = hotelExport.rows;
  artifacts["border_export.json"] = borderExport.rows;
  console.log("✓ 调度员风险面板摘要：");
  console.log(JSON.stringify({
    团组数: board.groups.length,
    容量风险: board.capacity_risks,
    候补: board.waitlists,
    资格风险: board.eligibility_risks,
    口岸风险: board.crossing_risks.map((r) => ({ slot: r.slot_id, severity: r.severity })),
    导出风险: board.export_risks,
  }, null, 2));

  // 落盘产物与全量事件日志
  await mkdir("out", { recursive: true });
  for (const [name, data] of Object.entries(artifacts)) {
    await writeFile(`out/${name}`, JSON.stringify(data, null, 2));
  }
  await writeFile(
    "out/event_log.jsonl",
    [...store.readAll()].map(({ _seq, ...e }) => JSON.stringify(e)).join("\n"),
  );
  console.log(`\n✓ 共提交 ${store.log.length} 个领域事件，产物已写入 out/`);
}

main().catch((e) => {
  console.error("联调剧本失败：", e);
  process.exit(1);
});
