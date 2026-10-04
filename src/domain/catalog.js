/**
 * 事件目录：每个事件类型约定 aggregate_type 与 payload 必填字段/枚举。
 * 这是跨模块交换的载荷契约，保持向后兼容（只追加，不删除既有字段）。
 */

const ACTIVITY_KINDS = ["chorus", "sports_games", "trade_fair"];
const LANGUAGES = ["zh", "ru", "en"];
const RESOURCE_KINDS = ["vehicle", "hotel_room", "event_seat"];
const SEAT_STATES = ["held", "waitlisted", "released"];
const ELIGIBILITY_STATES = ["requested", "confirmed", "denied"];
const BOOKING_KINDS = ["hotel", "vehicle"];
const CROSSING_DIRECTIONS = ["inbound", "outbound"];
const BATCH_STATUS = ["proposed", "accepted", "superseded"];

const spec = (aggregateType, payload = {}) => ({ aggregateType, payload });

export const EVENT_CATALOG = {
  // —— 团组与组织关系 ——
  GROUP_CREATED: spec("travel_group", {
    required: ["group_id", "activity_kind", "name"],
    enums: { activity_kind: ACTIVITY_KINDS },
  }),
  GROUP_UPDATED: spec("travel_group", {
    required: ["group_id", "changes"],
  }),
  LEADER_ASSIGNED: spec("travel_group", {
    required: ["group_id", "leader_id", "side"],
    enums: { side: ["domestic", "foreign"] },
  }),
  TEAM_DEFINED: spec("travel_group", {
    required: ["group_id", "team_id", "team_name"],
  }),

  // —— 成员档案（资格证件细节不进公共载荷） ——
  MEMBER_REGISTERED: spec("member_profile", {
    required: ["member_id", "group_id", "side", "display_name"],
    enums: { side: ["domestic", "foreign"] },
  }),
  MEMBER_PROFILE_UPDATED: spec("member_profile", {
    required: ["member_id", "changes"],
  }),
  MEMBER_WITHDRAWN: spec("member_profile", {
    required: ["member_id", "reason", "at"],
  }),
  NAME_DISAMBIGUATED: spec("member_profile", {
    required: ["member_ids", "resolution"],
  }),

  // —— 跨境资格：只接受有权来源 ——
  ELIGIBILITY_REQUESTED: spec("member_eligibility", {
    required: ["member_id", "document_ref", "authority"],
  }),
  ELIGIBILITY_CONFIRMED: spec("member_eligibility", {
    required: ["member_id", "authority", "state", "valid_until"],
    enums: { state: ELIGIBILITY_STATES },
  }),
  ELIGIBILITY_DENIED: spec("member_eligibility", {
    required: ["member_id", "authority", "state", "reason_code"],
    enums: { state: ELIGIBILITY_STATES },
  }),

  // —— 容量资源与占位（车辆/房间/席位）——
  // 占位是资源聚合内的实体：全部生命周期事件落在资源流上，
  // 以资源流版本做乐观并发控制，从根上杜绝并发超售。
  RESOURCE_DEFINED: spec("resource", {
    required: ["resource_id", "kind", "capacity", "label"],
    enums: { kind: RESOURCE_KINDS },
  }),
  RESOURCE_HELD: spec("resource", {
    required: [
      "hold_id",
      "resource_id",
      "member_id",
      "quantity",
      "state",
      "resource_version",
    ],
    enums: { state: SEAT_STATES },
  }),
  WAITLIST_JOINED: spec("resource", {
    required: ["hold_id", "resource_id", "member_id", "quantity", "rank"],
  }),
  WAITLIST_PROMOTED: spec("resource", {
    required: ["hold_id", "resource_id", "member_id", "resource_version"],
  }),
  HOLD_RELEASED: spec("resource", {
    required: ["hold_id", "resource_id", "member_id", "reason"],
  }),

  // —— 多人共用预订（旅行社订房/订车） ——
  BOOKING_CREATED: spec("booking", {
    required: [
      "booking_id",
      "kind",
      "group_id",
      "supplier",
      "capacity",
      "contract_ref",
    ],
    enums: { kind: BOOKING_KINDS },
  }),
  BOOKING_MEMBER_ATTACHED: spec("booking", {
    required: ["booking_id", "member_id"],
  }),
  BOOKING_MEMBER_DETACHED: spec("booking", {
    required: ["booking_id", "member_id", "reason"],
  }),
  BOOKING_CANCELLED: spec("booking", {
    required: ["booking_id", "reason", "at"],
  }),

  // —— 口岸分时与分批 ——
  CROSSING_SLOT_DEFINED: spec("crossing_slot", {
    required: ["slot_id", "port_code", "direction", "start_at", "capacity"],
    enums: { direction: CROSSING_DIRECTIONS },
  }),
  CROSSING_CAPACITY_CHANGED: spec("crossing_slot", {
    required: ["slot_id", "old_capacity", "new_capacity", "reason"],
  }),
  CROSSING_ASSIGNED: spec("crossing_slot", {
    required: ["slot_id", "group_id", "member_count", "batch_no"],
  }),
  CROSSING_BATCH_PROPOSED: spec("travel_group", {
    required: ["group_id", "plan_id", "status", "batches"],
    enums: { status: BATCH_STATUS },
  }),
  CROSSING_RESCHEDULED: spec("travel_group", {
    required: ["group_id", "from_slot_id", "to_slot_id", "reason"],
  }),

  // —— 合同、到访与结算 ——
  CONTRACT_AGREED: spec("contract", {
    required: ["contract_id", "group_id", "party", "version", "terms"],
  }),
  ATTENDANCE_RECORDED: spec("attendance_proof", {
    required: ["proof_id", "group_id", "member_id", "marked_at", "marker"],
  }),
  ATTENDANCE_SETTLED: spec("attendance_proof", {
    required: [
      "settlement_id",
      "group_id",
      "contract_id",
      "contract_version",
      "attended_count",
      "basis",
    ],
  }),
  CANCELLATION_LIABILITY_DECIDED: spec("contract", {
    required: [
      "contract_id",
      "contract_version",
      "member_id",
      "changed_at",
      "deadline_at",
      "liable",
      "rule",
    ],
  }),

  // —— 导出台账 ——
  EXPORT_ISSUED: spec("export_record", {
    required: [
      "export_id",
      "recipient",
      "purpose",
      "fields",
      "issued_at",
      "expires_at",
      "record_count",
    ],
  }),
  EXPORT_REVOKED: spec("export_record", {
    required: ["export_id", "revoked_at", "reason"],
  }),
  AUDIT_RECORDED: spec("audit_log", {
    required: ["audit_id", "action", "at"],
  }),
};

export function validatePayload(eventType, payload = {}) {
  const entry = EVENT_CATALOG[eventType];
  if (!entry) return [`事件目录未登记：${eventType}`];
  const errors = (entry.payload.required || [])
    .filter((name) => !(name in payload))
    .map((name) => `payload 缺少字段：${name}`);
  for (const [field, allowed] of Object.entries(entry.payload.enums || {})) {
    if (field in payload && !allowed.includes(payload[field])) {
      errors.push(`payload.${field} 取值非法：${payload[field]}`);
    }
  }
  return errors;
}

export {
  ACTIVITY_KINDS,
  LANGUAGES,
  RESOURCE_KINDS,
  BOOKING_KINDS,
  CROSSING_DIRECTIONS,
};
