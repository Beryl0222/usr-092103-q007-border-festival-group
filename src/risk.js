// 调度员风险总览：汇总各团组在资格、保险、紧急联系人、候补、资源分配、
// 口岸限流与导出时效上的未决事项，双语呈现。
export class RiskService {
  constructor({ members, eligibility, inventory, crossing, exportService }) {
    this.members = members;
    this.eligibility = eligibility;
    this.inventory = inventory;
    this.crossing = crossing;
    this.exportService = exportService;
  }

  groupRisks(group_id, { activity_start = null, now = null } = {}) {
    const at = now ?? this.members.store.now();
    const findings = [];
    this.members.getGroup(group_id);
    for (const member of this.members.allOfGroup(group_id)) {
      if (member.status === "withdrawn") continue;
      if (this.eligibility.status(member.member_id, "cross_border") !== "confirmed") {
        findings.push({
          severity: "high",
          code: "MISSING_ELIGIBILITY",
          member_id: member.member_id,
          message_zh: `成员 ${member.name_zh} 缺少有权来源的跨境资格确认`,
          message_ru: `Участник ${member.name_zh}: нет подтверждения права пересечения границы`,
        });
      }
      if (!member.insurance) {
        findings.push({
          severity: "high",
          code: "INSURANCE_MISSING",
          member_id: member.member_id,
          message_zh: `成员 ${member.name_zh} 缺少保险`,
          message_ru: `Участник ${member.name_zh}: нет страховки`,
        });
      } else if (activity_start && Date.parse(member.insurance.valid_until) < Date.parse(activity_start)) {
        findings.push({
          severity: "medium",
          code: "INSURANCE_EXPIRED",
          member_id: member.member_id,
          message_zh: `成员 ${member.name_zh} 的保险在活动开始前到期`,
          message_ru: `Участник ${member.name_zh}: страховка истекает до начала`,
        });
      }
      if (!member.emergency_contact) {
        findings.push({
          severity: "medium",
          code: "MISSING_EMERGENCY_CONTACT",
          member_id: member.member_id,
          message_zh: `成员 ${member.name_zh} 缺少紧急联系人`,
          message_ru: `Участник ${member.name_zh}: нет экстренного контакта`,
        });
      }
      if (member.status === "active") {
        if (!this.inventory.assignmentFor(member.member_id, "room")) {
          findings.push({
            severity: "medium",
            code: "UNASSIGNED_ROOM",
            member_id: member.member_id,
            message_zh: `成员 ${member.name_zh} 尚未分房`,
            message_ru: `Участник ${member.name_zh}: комната не назначена`,
          });
        }
        if (!this.inventory.assignmentFor(member.member_id, "vehicle")) {
          findings.push({
            severity: "medium",
            code: "UNASSIGNED_VEHICLE",
            member_id: member.member_id,
            message_zh: `成员 ${member.name_zh} 尚未排车`,
            message_ru: `Участник ${member.name_zh}: автобус не назначен`,
          });
        }
      }
    }
    const waitlisted = this.members.waitlistedMembers(group_id);
    if (waitlisted.length) {
      findings.push({
        severity: "low",
        code: "WAITLIST_PENDING",
        message_zh: `${waitlisted.length} 名候补成员待转正`,
        message_ru: `${waitlisted.length} в листе ожидания`,
      });
    }
    for (const slot of this.crossing.slots.values()) {
      if (slot.assignments.includes(group_id) && slot.capacity < slot.base_capacity) {
        findings.push({
          severity: "medium",
          code: "SLOT_RESTRICTED",
          message_zh: `口岸 ${slot.port} 已限流（${slot.base_capacity}→${slot.capacity}），需确认分批方案`,
          message_ru: `Пункт пропуска ${slot.port}: ограничение (${slot.base_capacity}→${slot.capacity}), нужен план партий`,
        });
      }
    }
    for (const record of this.exportService.records.values()) {
      if (record.group_id !== group_id) continue;
      const ms = Date.parse(record.expires_at) - Date.parse(at);
      if (ms <= 0) {
        findings.push({
          severity: "medium",
          code: "EXPORT_EXPIRED",
          message_zh: `导出 ${record.export_id}（${record.recipient}）已失效，不得继续使用`,
          message_ru: `Экспорт ${record.export_id} (${record.recipient}) истёк`,
        });
      } else if (ms <= 24 * 3_600_000) {
        findings.push({
          severity: "low",
          code: "EXPORT_EXPIRING",
          message_zh: `导出 ${record.export_id}（${record.recipient}）将于 ${record.expires_at} 失效`,
          message_ru: `Экспорт ${record.export_id} (${record.recipient}) истекает ${record.expires_at}`,
        });
      }
    }
    return findings;
  }

  overview(options = {}) {
    const result = {};
    for (const group of this.members.groups.values()) {
      result[group.group_id] = this.groupRisks(group.group_id, options);
    }
    return result;
  }
}
