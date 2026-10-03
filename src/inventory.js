import { ConcurrencyError, DomainError } from "./events.js";

const ACTIVE_HOLD = new Set(["placed", "confirmed"]);

// 车辆、房间、席位统一建模为带容量的资源。
// 同一资源的全部预订事件落在同一聚合版本序列上：写入方携带 expected_version，
// 并发下只有一个写入成功，另一个收到 ConcurrencyError 后重读容量重试，从而避免超售。
// 多人共用预订（拼房、同车）即一条 hold 携带多个 member_ids，全程留痕。
export class InventoryService {
  constructor(store) {
    this.store = store;
    this.resources = new Map();
  }

  registerResource({ resource_id, kind, capacity, label, program = null, session_id = null }) {
    if (this.resources.has(resource_id)) throw new DomainError(`资源已存在：${resource_id}`);
    const resource = { resource_id, kind, capacity, label, program, session_id, holds: new Map() };
    this.resources.set(resource_id, resource);
    this.store.append({
      event_type: "RESOURCE_REGISTERED",
      aggregate_type: "inventory_resource",
      aggregate_id: resource_id,
      summary: `资源登记：${label}`,
      payload: { kind, capacity, label, program, session_id },
    });
    return resource;
  }

  get(resource_id) {
    const resource = this.resources.get(resource_id);
    if (!resource) throw new DomainError(`资源不存在：${resource_id}`);
    return resource;
  }

  activeHolds(resource_id) {
    return [...this.get(resource_id).holds.values()].filter((h) => ACTIVE_HOLD.has(h.status));
  }

  occupancy(resource_id) {
    return this.activeHolds(resource_id).reduce((n, h) => n + h.member_ids.length, 0);
  }

  remaining(resource_id) {
    const resource = this.get(resource_id);
    return resource.capacity - this.occupancy(resource_id);
  }

  placeHold({ resource_id, hold_id, member_ids, expected_version = null, ttl_seconds = null }) {
    const resource = this.get(resource_id);
    if (resource.holds.has(hold_id)) throw new DomainError(`预订号重复：${hold_id}`);
    // 先校验写入方版本：并发下拿着过期版本的写入直接拒绝，由调用方重读容量后重试
    if (expected_version !== null && expected_version !== this.store.versionOf("inventory_resource", resource_id)) {
      throw new ConcurrencyError(`版本冲突：资源 ${resource_id} 已被他人变更，请重读后重试`);
    }
    for (const memberId of member_ids) {
      const existing = this.activeHolds(resource_id).find((h) => h.member_ids.includes(memberId));
      if (existing) throw new DomainError(`成员 ${memberId} 在资源 ${resource_id} 已有预订 ${existing.hold_id}`);
    }
    const remaining = this.remaining(resource_id);
    if (member_ids.length > remaining) {
      throw new DomainError(`资源 ${resource_id} 容量不足：剩余 ${remaining}，需要 ${member_ids.length}`);
    }
    const expires_at = ttl_seconds ? new Date(Date.parse(this.store.now()) + ttl_seconds * 1000).toISOString() : null;
    const event = this.store.append({
      event_type: "RESOURCE_HELD",
      aggregate_type: "inventory_resource",
      aggregate_id: resource_id,
      expected_version,
      summary: `资源预订：${resource.label}（${member_ids.length} 人）`,
      payload: { hold_id, member_ids: [...member_ids], kind: resource.kind, expires_at },
    });
    resource.holds.set(hold_id, { hold_id, member_ids: [...member_ids], status: "placed", expires_at });
    return event;
  }

  confirmHold({ resource_id, hold_id, expected_version = null }) {
    return this.#transition(resource_id, hold_id, "placed", "confirmed", "RESOURCE_HOLD_CONFIRMED", "预订确认", expected_version);
  }

  releaseHold({ resource_id, hold_id, reason = null, expected_version = null }) {
    return this.#transition(resource_id, hold_id, null, "released", "RESOURCE_HOLD_RELEASED", "预订释放", expected_version, reason);
  }

  // 占位超时未确认则失效，释放容量供当晚排定使用
  expireHolds(now = this.store.now()) {
    const at = Date.parse(now);
    const expired = [];
    for (const resource of this.resources.values()) {
      for (const hold of resource.holds.values()) {
        if (hold.status === "placed" && hold.expires_at && Date.parse(hold.expires_at) <= at) {
          this.#transition(resource.resource_id, hold.hold_id, "placed", "expired", "RESOURCE_HOLD_EXPIRED", "预订超时失效");
          expired.push(hold.hold_id);
        }
      }
    }
    return expired;
  }

  #transition(resource_id, hold_id, from, to, eventType, label, expected_version = null, reason = null) {
    const resource = this.get(resource_id);
    const hold = resource.holds.get(hold_id);
    if (!hold) throw new DomainError(`预订不存在：${hold_id}`);
    if (from && hold.status !== from) throw new DomainError(`预订 ${hold_id} 状态为 ${hold.status}，不能执行该操作`);
    if (!from && !ACTIVE_HOLD.has(hold.status)) throw new DomainError(`预订 ${hold_id} 已结束（${hold.status}）`);
    hold.status = to;
    return this.store.append({
      event_type: eventType,
      aggregate_type: "inventory_resource",
      aggregate_id: resource_id,
      expected_version,
      summary: `${label}：${resource.label}`,
      payload: { hold_id, member_ids: [...hold.member_ids], reason },
    });
  }

  assignmentFor(member_id, kind) {
    for (const resource of this.resources.values()) {
      if (resource.kind !== kind) continue;
      const hold = this.activeHolds(resource.resource_id).find((h) => h.member_ids.includes(member_id));
      if (hold) return resource.label;
    }
    return null;
  }
}
