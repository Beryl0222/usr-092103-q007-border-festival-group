// 结算与取消责任：
// - 取消责任按变更时点（occurred_at）落在哪个合同版本、距离活动开始多少小时来判定费率；
// - 活动结束后以实际到访（ATTENDANCE_RECORDED）为合作结算依据，取消费用并入结算。
export class SettlementService {
  constructor(store, contracts, members) {
    this.store = store;
    this.contracts = contracts;
    this.members = members;
  }

  recordAttendance({ member_id, activity_id, arrived_at, source = "checkpoint" }) {
    return this.store.append({
      event_type: "ATTENDANCE_RECORDED",
      aggregate_type: "attendance_proof",
      aggregate_id: `${activity_id}:${member_id}`,
      summary: `实际到访：${member_id}`,
      payload: { member_id, activity_id, arrived_at, source },
      occurred_at: arrived_at,
    });
  }

  assessCancellation({ member_id, group, activity_id, activity_start, occurred_at }) {
    const contract = this.contracts.versionAt(group.contract_id, occurred_at);
    const hoursBefore = (Date.parse(activity_start) - Date.parse(occurred_at)) / 3_600_000;
    const tier =
      contract.cancellation_tiers
        .filter((t) => hoursBefore >= t.min_hours_before)
        .sort((a, b) => b.min_hours_before - a.min_hours_before)[0] ?? { min_hours_before: 0, fee_percent: 100 };
    const fee_cents = Math.round((contract.price_per_member_cents * tier.fee_percent) / 100);
    return this.store.append({
      event_type: "CANCELLATION_ASSESSED",
      aggregate_type: "group_member",
      aggregate_id: member_id,
      summary: `取消责任核定：${member_id} 费率 ${tier.fee_percent}%`,
      payload: {
        member_id,
        group_id: group.group_id,
        activity_id,
        contract_id: contract.contract_id,
        contract_version: contract.version,
        hours_before: Math.round(hoursBefore * 100) / 100,
        fee_percent: tier.fee_percent,
        fee_cents,
        currency: contract.currency,
      },
      occurred_at,
    });
  }

  computeSettlement({ group, activity_id, activity_start }) {
    const contract = this.contracts.versionAt(group.contract_id, activity_start);
    const groupMembers = this.members.allOfGroup(group.group_id);
    const attended = this.store
      .ofType("ATTENDANCE_RECORDED")
      .filter((e) => e.payload.activity_id === activity_id && groupMembers.some((m) => m.member_id === e.payload.member_id));
    const fees = this.store
      .ofType("CANCELLATION_ASSESSED")
      .filter((e) => e.payload.group_id === group.group_id && e.payload.activity_id === activity_id);
    const cancellation_fee_cents = fees.reduce((n, e) => n + e.payload.fee_cents, 0);
    const attendance_charges_cents = attended.length * contract.price_per_member_cents;
    const booked_count = this.members.activeMembers(group.group_id).length + fees.length;
    return this.store.append({
      event_type: "SETTLEMENT_COMPUTED",
      aggregate_type: "settlement",
      aggregate_id: `${group.group_id}:${activity_id}`,
      summary: `结算核定：${group.name_zh} 实际到访 ${attended.length} 人`,
      payload: {
        group_id: group.group_id,
        activity_id,
        contract_id: contract.contract_id,
        contract_version: contract.version,
        booked_count,
        attended_count: attended.length,
        attended_member_ids: attended.map((e) => e.payload.member_id),
        attendance_charges_cents,
        cancellation_fee_cents,
        total_cents: attendance_charges_cents + cancellation_fee_cents,
        currency: contract.currency,
      },
    });
  }
}
