// 领域事件类型与聚合类型的稳定枚举，与 contracts/domain.schema.json 保持一致。
export const AGGREGATE_TYPES = [
  "travel_group",
  "group_member",
  "member_eligibility",
  "inventory_resource",
  "resource_hold",
  "crossing_slot",
  "attendance_proof",
  "contract",
  "settlement",
  "export_record",
];

export const EVENT_TYPES = [
  "GROUP_CREATED",
  "MEMBER_REGISTERED",
  "MEMBER_WAITLISTED",
  "MEMBER_UPDATED",
  "MEMBER_WITHDRAWN",
  "WAITLIST_PROMOTED",
  "ELIGIBILITY_CONFIRMED",
  "ELIGIBILITY_REVOKED",
  "RESOURCE_REGISTERED",
  "RESOURCE_HELD",
  "RESOURCE_HOLD_CONFIRMED",
  "RESOURCE_HOLD_RELEASED",
  "RESOURCE_HOLD_EXPIRED",
  "CROSSING_SLOT_PUBLISHED",
  "CROSSING_GROUP_ASSIGNED",
  "CROSSING_FLOW_RESTRICTED",
  "CROSSING_BATCHING_PROPOSED",
  "CROSSING_RESCHEDULED",
  "ATTENDANCE_RECORDED",
  "CONTRACT_PUBLISHED",
  "CANCELLATION_ASSESSED",
  "SETTLEMENT_COMPUTED",
  "EXPORT_ISSUED",
];

export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = "DomainError";
  }
}

export class ConcurrencyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ConcurrencyError";
    this.details = details;
  }
}

export class AuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorizationError";
  }
}

// 追加式事件存储：每个聚合一条单调递增的版本序列，
// 写入方可携带 expected_version 做乐观并发控制，冲突时抛 ConcurrencyError 由调用方重试。
export class EventStore {
  #events = [];
  #versions = new Map();
  #seq = 0;
  #now;

  constructor({ now } = {}) {
    this.#now = now ?? (() => new Date().toISOString());
  }

  now() {
    return this.#now();
  }

  #key(aggregateType, aggregateId) {
    return `${aggregateType}:${aggregateId}`;
  }

  versionOf(aggregateType, aggregateId) {
    return this.#versions.get(this.#key(aggregateType, aggregateId)) ?? 0;
  }

  append({
    event_type,
    aggregate_type,
    aggregate_id,
    summary,
    payload = {},
    actor = "system",
    expected_version = null,
    occurred_at = null,
  }) {
    if (!EVENT_TYPES.includes(event_type)) throw new DomainError(`未知事件类型：${event_type}`);
    if (!AGGREGATE_TYPES.includes(aggregate_type)) throw new DomainError(`未知聚合类型：${aggregate_type}`);
    const current = this.versionOf(aggregate_type, aggregate_id);
    if (expected_version !== null && expected_version !== current) {
      throw new ConcurrencyError(
        `版本冲突：${aggregate_type}:${aggregate_id} 当前版本 ${current}，写入方期望 ${expected_version}`,
        { current, expected_version },
      );
    }
    const version = current + 1;
    const event = {
      event_id: `evt-${String(++this.#seq).padStart(6, "0")}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: occurred_at ?? this.#now(),
      version,
      summary,
      payload,
      actor,
    };
    this.#events.push(event);
    this.#versions.set(this.#key(aggregate_type, aggregate_id), version);
    return event;
  }

  all() {
    return [...this.#events];
  }

  ofAggregate(aggregateType, aggregateId) {
    return this.#events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId);
  }

  ofType(eventType) {
    return this.#events.filter((e) => e.event_type === eventType);
  }
}
