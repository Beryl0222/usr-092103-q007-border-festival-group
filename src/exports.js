import { DomainError } from "./events.js";
import { LABELS, bilingual, statusLabel } from "./i18n.js";

// 最小化披露矩阵：合作方只拿到履约所需字段，证件细节仅口岸有权渠道可见。
export const DISCLOSURE = {
  leader: [
    "name_zh",
    "name_ru",
    "role",
    "languages",
    "eligibility_status",
    "insurance_status",
    "emergency_contact",
    "room",
    "vehicle",
    "seat",
  ],
  partner_hotel: ["name_zh", "name_ru", "room", "group_name"],
  partner_transport: ["name_zh", "name_ru", "vehicle", "seat", "group_name"],
  partner_stage: ["name_zh", "name_ru", "seat", "group_name"],
  border_control: ["name_zh", "name_ru", "birth_date", "document_ref", "eligibility_status"],
};

// 名单导出：每次导出登记接收方、用途与失效时间，并落 EXPORT_ISSUED 事件留痕。
export class ExportService {
  constructor(store, members, inventory, eligibility) {
    this.store = store;
    this.members = members;
    this.inventory = inventory;
    this.eligibility = eligibility;
    this.records = new Map();
    this.seq = 0;
  }

  issue({ group_id, audience, recipient, purpose, ttl_seconds, now = null }) {
    const fields = DISCLOSURE[audience];
    if (!fields) throw new DomainError(`未知接收对象：${audience}`);
    if (!recipient || !purpose) throw new DomainError("导出必须登记接收方与用途");
    if (!Number.isInteger(ttl_seconds) || ttl_seconds <= 0) throw new DomainError("导出必须设置失效时间");
    const group = this.members.getGroup(group_id);
    const issued_at = now ?? this.store.now();
    const expires_at = new Date(Date.parse(issued_at) + ttl_seconds * 1000).toISOString();
    const rows = this.members
      .allOfGroup(group_id)
      .filter((m) => m.status !== "withdrawn")
      .map((m) => this.#row(m, group, fields, issued_at));
    const export_id = `exp-${String(++this.seq).padStart(4, "0")}`;
    const record = {
      export_id,
      group_id,
      audience,
      recipient,
      purpose,
      fields: [...fields],
      row_count: rows.length,
      issued_at,
      expires_at,
    };
    this.records.set(export_id, record);
    this.store.append({
      event_type: "EXPORT_ISSUED",
      aggregate_type: "export_record",
      aggregate_id: export_id,
      summary: `名单导出：${group.name_zh} → ${recipient}（${purpose}）`,
      payload: { ...record },
    });
    return { record, rows, table: renderTable(fields, rows) };
  }

  #row(member, group, fields, now) {
    const row = {};
    for (const field of fields) row[field] = this.#value(member, group, field, now);
    return row;
  }

  #value(member, group, field, now) {
    switch (field) {
      case "name_zh":
        return member.name_zh;
      case "name_ru":
        return member.name_ru ?? "—";
      case "role":
        return statusLabel(member.role);
      case "languages":
        return member.languages.join("/") || "—";
      case "eligibility_status":
        return statusLabel(this.eligibility.status(member.member_id, "cross_border") === "confirmed" ? "confirmed" : "pending");
      case "insurance_status": {
        if (!member.insurance) return statusLabel("missing");
        return statusLabel(Date.parse(member.insurance.valid_until) >= Date.parse(now) ? "valid" : "expired");
      }
      case "emergency_contact":
        return member.emergency_contact ? `${member.emergency_contact.name} ${member.emergency_contact.phone}` : "—";
      case "document_ref":
        return member.document_ref ?? "—";
      case "birth_date":
        return member.birth_date ?? "—";
      case "room":
        return this.inventory.assignmentFor(member.member_id, "room") ?? "—";
      case "vehicle":
        return this.inventory.assignmentFor(member.member_id, "vehicle") ?? "—";
      case "seat":
        return this.inventory.assignmentFor(member.member_id, "seat") ?? "—";
      case "group_name":
        return group.name_ru ? `${group.name_zh} / ${group.name_ru}` : group.name_zh;
      default:
        throw new DomainError(`未知导出字段：${field}`);
    }
  }

  get(export_id) {
    const record = this.records.get(export_id);
    if (!record) throw new DomainError(`导出记录不存在：${export_id}`);
    return record;
  }

  expired(now = this.store.now()) {
    return [...this.records.values()].filter((r) => Date.parse(r.expires_at) <= Date.parse(now));
  }

  assertValid(export_id, now = this.store.now()) {
    const record = this.get(export_id);
    if (Date.parse(record.expires_at) <= Date.parse(now)) {
      throw new DomainError(`导出已失效：${export_id}（失效于 ${record.expires_at}）`);
    }
    return record;
  }
}

export function renderTable(fields, rows) {
  const header = fields.map((f) => bilingual(LABELS, f)).join(" | ");
  const lines = rows.map((row) => fields.map((f) => String(row[f])).join(" | "));
  return [header, ...lines].join("\n");
}
