const required = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

export const EVENT_TYPES = [
  "GROUP_CREATED",
  "GROUP_UPDATED",
  "LEADER_ASSIGNED",
  "TEAM_DEFINED",
  "MEMBER_REGISTERED",
  "MEMBER_PROFILE_UPDATED",
  "MEMBER_WITHDRAWN",
  "NAME_DISAMBIGUATED",
  "ELIGIBILITY_REQUESTED",
  "ELIGIBILITY_CONFIRMED",
  "ELIGIBILITY_DENIED",
  "RESOURCE_DEFINED",
  "RESOURCE_HELD",
  "WAITLIST_JOINED",
  "WAITLIST_PROMOTED",
  "HOLD_RELEASED",
  "BOOKING_CREATED",
  "BOOKING_MEMBER_ATTACHED",
  "BOOKING_MEMBER_DETACHED",
  "BOOKING_CANCELLED",
  "CROSSING_SLOT_DEFINED",
  "CROSSING_CAPACITY_CHANGED",
  "CROSSING_ASSIGNED",
  "CROSSING_BATCH_PROPOSED",
  "CROSSING_RESCHEDULED",
  "CONTRACT_AGREED",
  "ATTENDANCE_RECORDED",
  "ATTENDANCE_SETTLED",
  "CANCELLATION_LIABILITY_DECIDED",
  "EXPORT_ISSUED",
  "EXPORT_REVOKED",
  "AUDIT_RECORDED",
];

export const AGGREGATE_TYPES = [
  "travel_group",
  "member_profile",
  "member_eligibility",
  "resource",
  "resource_hold",
  "booking",
  "crossing_slot",
  "contract",
  "attendance_proof",
  "export_record",
  "audit_log",
];

export const SOURCE_KINDS = [
  "port_authority",
  "consular_authority",
  "domestic_organizer",
  "foreign_organizer",
  "travel_agent",
  "festival_dispatch",
  "system",
];

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** 校验公共信封；payload 细则由 domain/catalog.js 的 validatePayload 负责。 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (
    "version" in record &&
    (!Number.isInteger(record.version) || record.version < 1)
  ) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if (
    "aggregate_type" in record &&
    !AGGREGATE_TYPES.includes(record.aggregate_type)
  ) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if ("occurred_at" in record && !isIsoDateTime(record.occurred_at)) {
    errors.push("occurred_at 必须是 ISO 日期时间");
  }
  if ("source" in record && record.source) {
    if (!record.source.id) errors.push("source.id 不能为空");
    if (!SOURCE_KINDS.includes(record.source.kind)) {
      errors.push(`未知 source.kind：${record.source.kind}`);
    }
  }
  return errors;
}
