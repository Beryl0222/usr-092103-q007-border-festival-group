import { DomainError } from "./events.js";

// 口岸分时通行：时段容量被临时限流下调时，按团队关系把团组整体装入分批方案，
// 单团超过限流容量时按成员顺序（领队在前）拆成连续批次。
// 只追加 CROSSING_RESCHEDULED 改期事件，不删除任何行程。
export class CrossingService {
  constructor(store, members) {
    this.store = store;
    this.members = members;
    this.slots = new Map();
  }

  publishSlot({ slot_id, port, start, end, capacity }) {
    if (this.slots.has(slot_id)) throw new DomainError(`通行时段已存在：${slot_id}`);
    const slot = { slot_id, port, start, end, capacity, base_capacity: capacity, assignments: [] };
    this.slots.set(slot_id, slot);
    this.store.append({
      event_type: "CROSSING_SLOT_PUBLISHED",
      aggregate_type: "crossing_slot",
      aggregate_id: slot_id,
      summary: `通行时段发布：${port} ${start}`,
      payload: { port, start, end, capacity },
    });
    return slot;
  }

  get(slot_id) {
    const slot = this.slots.get(slot_id);
    if (!slot) throw new DomainError(`通行时段不存在：${slot_id}`);
    return slot;
  }

  assignGroup({ slot_id, group_id }) {
    const slot = this.get(slot_id);
    if (slot.assignments.includes(group_id)) throw new DomainError(`团组 ${group_id} 已分配到时段 ${slot_id}`);
    slot.assignments.push(group_id);
    return this.store.append({
      event_type: "CROSSING_GROUP_ASSIGNED",
      aggregate_type: "crossing_slot",
      aggregate_id: slot_id,
      summary: `团组分配通行时段：${group_id} → ${slot.port}`,
      payload: { slot_id, group_id },
    });
  }

  restrict({ slot_id, new_capacity, reason, occurred_at = null }) {
    const slot = this.get(slot_id);
    if (!Number.isInteger(new_capacity) || new_capacity < 1) throw new DomainError("限流容量必须是正整数");
    if (new_capacity >= slot.capacity) throw new DomainError("限流必须降低容量");
    slot.capacity = new_capacity;
    return this.store.append({
      event_type: "CROSSING_FLOW_RESTRICTED",
      aggregate_type: "crossing_slot",
      aggregate_id: slot_id,
      summary: `口岸限流：${slot.port} 容量降至 ${new_capacity}`,
      payload: { slot_id, new_capacity, reason },
      occurred_at,
    });
  }

  proposeBatching({ slot_id }) {
    const slot = this.get(slot_id);
    const groups = slot.assignments
      .map((group_id) => {
        const active = this.members.activeMembers(group_id);
        const leaders = active.filter((m) => m.role === "leader");
        const rest = active.filter((m) => m.role !== "leader");
        return { group_id, member_ids: [...leaders, ...rest].map((m) => m.member_id) };
      })
      .filter((g) => g.member_ids.length > 0);
    const demand = groups.reduce((n, g) => n + g.member_ids.length, 0);
    if (demand === 0) throw new DomainError("时段内没有待通行成员");

    const batches = [];
    let current = { groups: [], member_ids: [] };
    const flush = () => {
      if (current.member_ids.length) {
        batches.push(current);
        current = { groups: [], member_ids: [] };
      }
    };
    for (const group of groups) {
      if (group.member_ids.length > slot.capacity) {
        // 单团超过限流容量：拆成连续批次，领队在第一批
        flush();
        for (let i = 0; i < group.member_ids.length; i += slot.capacity) {
          const chunk = group.member_ids.slice(i, i + slot.capacity);
          batches.push({ groups: [{ group_id: group.group_id, member_ids: chunk, split: true }], member_ids: chunk });
        }
        continue;
      }
      if (current.member_ids.length + group.member_ids.length > slot.capacity) flush();
      current.groups.push({ group_id: group.group_id, member_ids: group.member_ids, split: false });
      current.member_ids.push(...group.member_ids);
    }
    flush();

    const startMs = Date.parse(slot.start);
    const endMs = Date.parse(slot.end);
    const span = (endMs - startMs) / batches.length;
    const plan = batches.map((batch, i) => ({
      batch_no: i + 1,
      window: {
        start: new Date(startMs + i * span).toISOString(),
        end: new Date(startMs + (i + 1) * span).toISOString(),
      },
      groups: batch.groups,
      size: batch.member_ids.length,
    }));

    this.store.append({
      event_type: "CROSSING_BATCHING_PROPOSED",
      aggregate_type: "crossing_slot",
      aggregate_id: slot_id,
      summary: `分批方案：${slot.port} 共 ${plan.length} 批`,
      payload: { slot_id, capacity: slot.capacity, batches: plan },
    });
    for (const batch of plan) {
      for (const group of batch.groups) {
        this.store.append({
          event_type: "CROSSING_RESCHEDULED",
          aggregate_type: "travel_group",
          aggregate_id: group.group_id,
          summary: `通行改期：${group.group_id} 第 ${batch.batch_no} 批`,
          payload: {
            slot_id,
            batch_no: batch.batch_no,
            window: batch.window,
            member_ids: group.member_ids,
            split: group.split,
            reason: "flow_restriction",
          },
        });
      }
    }
    return { slot_id, batches: plan, changed: plan.length > 1 || slot.capacity < slot.base_capacity };
  }
}
