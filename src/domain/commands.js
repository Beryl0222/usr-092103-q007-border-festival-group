/**
 * 命令层：可实际运行的业务操作入口。
 * 每个命令完成：加载投影快照 -> 策略校验 -> 在聚合流上追加事件（乐观并发）。
 * 容量类命令内置并发冲突自动重试，保证并发预订绝不超售。
 */
import { DomainError } from "./store.js";
import { Projection } from "./projection.js";
import {
  confirmEligibilityPolicy,
  recordAttendancePolicy,
  memberSidePolicy,
  decideCancellationLiability,
  Unauthorized,
} from "./policy.js";

export class CapacityExceeded extends DomainError {
  constructor(resourceId, free, wanted) {
    super(`资源 ${resourceId} 容量不足：剩余 ${free}，申请 ${wanted}`);
    this.code = "CAPACITY_EXCEEDED";
  }
}

export class IllegalState extends DomainError {}

const DEFAULT_RETRY = 8;

export class Commands {
  constructor(store, { now } = {}) {
    this.store = store;
    this.now = now ?? (() => new Date().toISOString());
  }

  /** 取当前快照（事件存储为全内存时开销可忽略）。 */
  _snapshot() {
    return Projection.build(this.store);
  }

  async _retry(fn, retries = DEFAULT_RETRY) {
    for (let attempt = 0; ; attempt += 1) {
      // 统一在事件循环边界后读快照，使并发命令真正交错，冲突由 CAS 收口
      await new Promise((resolve) => setImmediate(resolve));
      try {
        return fn(attempt);
      } catch (err) {
        if (err.code === "CONCURRENT_MODIFICATION" && attempt < retries) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * 构造“释放一个占位 + 候补按序转正”的原子批次草稿。
   * 转正严格受容量约束；resource_version 按批次内位置预先排定。
   */
  _releaseWithPromotions(snap, hold, actor, reason, correlationId) {
    const resourceId = hold.resource_id;
    const resource = snap.resources.get(resourceId);
    const drafts = [
      {
        event_type: "HOLD_RELEASED",
        aggregate_type: "resource",
        aggregate_id: resourceId,
        summary: `释放占位：${hold.hold_id}`,
        actor,
        correlation_id: correlationId,
        payload: { hold_id: hold.hold_id, resource_id: resourceId, member_id: hold.member_id, reason },
      },
    ];
    let running =
      snap.usedCapacity(resourceId) - (hold.state === "held" ? hold.quantity : 0);
    const baseVersion = this.store.version(resourceId);
    for (const candidate of snap.waitlist(resourceId)) {
      if (running + candidate.quantity <= resource.capacity) {
        running += candidate.quantity;
        drafts.push({
          event_type: "WAITLIST_PROMOTED",
          aggregate_type: "resource",
          aggregate_id: resourceId,
          summary: `候补转正：${candidate.member_id}`,
          actor,
          correlation_id: correlationId,
          payload: {
            hold_id: candidate.hold_id,
            resource_id: resourceId,
            member_id: candidate.member_id,
            // HOLD_RELEASED 占 1 个版本，后续转正依次递增
            resource_version: baseVersion + drafts.length + 1,
          },
        });
      }
    }
    return drafts;
  }

  // ================= 团组 =================
  createGroup({ group_id, activity_kind, name, actor, source, correlation_id }) {
    return this.store.append({
      event_type: "GROUP_CREATED",
      aggregate_type: "travel_group",
      aggregate_id: group_id,
      summary: `建团：${name}`,
      actor, source, correlation_id,
      payload: { group_id, activity_kind, name },
    });
  }

  assignLeader({ group_id, side, leader_id, leader_name, actor }) {
    return this.store.append({
      event_type: "LEADER_ASSIGNED",
      aggregate_type: "travel_group",
      aggregate_id: group_id,
      summary: `${side === "domestic" ? "中方" : "俄方"}领队 ${leader_name ?? leader_id}`,
      actor,
      payload: { group_id, side, leader_id, leader_name },
    });
  }

  defineTeam({ group_id, team_id, team_name, parent_team_id, kind, actor }) {
    return this.store.append({
      event_type: "TEAM_DEFINED",
      aggregate_type: "travel_group",
      aggregate_id: group_id,
      summary: `团队关系：${team_name}`,
      actor,
      payload: { group_id, team_id, team_name, parent_team_id, kind },
    });
  }

  // ================= 成员 =================
  registerMember(cmd) {
    const {
      member_id, group_id, team_id, side, display_name,
      languages, needs_interpreter, role, dietary, phone,
      emergency_contact, insurance, actor,
    } = cmd;
    // 领队只能为本方注册成员（调度员/系统不受限）
    if (actor?.role === "leader" && actor.side !== side) {
      throw new Unauthorized(
        `${actor.side} 方领队不能登记 ${side} 方成员 ${member_id}`,
      );
    }
    return this.store.append({
      event_type: "MEMBER_REGISTERED",
      aggregate_type: "member_profile",
      aggregate_id: member_id,
      summary: `成员登记：${display_name}`,
      actor,
      payload: {
        member_id, group_id, team_id, side, display_name,
        languages, needs_interpreter, role, dietary,
        // 电话/保险/紧急联系人进入成员流（领队自用与授权用途可见），
        // 但不会进入外发事件；导出时按用途最小化。
        phone, emergency_contact, insurance,
      },
    });
  }

  updateMember({ member_id, changes, actor }) {
    const snap = this._snapshot();
    const member = snap.members.get(member_id);
    if (!member) throw new IllegalState(`成员不存在：${member_id}`);
    memberSidePolicy({ actor, member, action: "修改" });
    return this.store.append({
      event_type: "MEMBER_PROFILE_UPDATED",
      aggregate_type: "member_profile",
      aggregate_id: member_id,
      summary: `成员资料更新：${member.display_name}`,
      actor,
      payload: { member_id, changes },
    });
  }

  /** 成员退出：记录原因与时点，供取消责任判定与过程追溯。 */
  async withdrawMember({ member_id, reason, at, actor }) {
    const snap = this._snapshot();
    const member = snap.members.get(member_id);
    if (!member) throw new IllegalState(`成员不存在：${member_id}`);
    if (member.status === "withdrawn") {
      throw new IllegalState(`成员已退出：${member_id}`);
    }
    memberSidePolicy({ actor, member, action: "退出登记" });
    // 联动释放其名下全部“持有中”的席位/车位/床位（保留过程事件，不删行程）
    // 并按各资源的候补顺序自动转正；每个资源一次原子批次
    const results = [];
    const byResource = new Map();
    for (const hold of snap.holds.values()) {
      if (hold.member_id === member_id && hold.state === "held") {
        if (!byResource.has(hold.resource_id)) byResource.set(hold.resource_id, []);
        byResource.get(hold.resource_id).push(hold);
      }
    }
    for (const [resourceId, holds] of byResource) {
      // 逐个释放：每次以最新快照重算候补，保证版本与容量正确
      for (const hold of holds) {
        const fresh = this._snapshot();
        const current = fresh.holds.get(hold.hold_id);
        if (!current || current.state !== "held") continue;
        const out = await this.releaseHold({
          hold_id: hold.hold_id,
          reason: `member_withdrawn:${reason}`,
          actor,
        });
        results.push(...out);
      }
      void resourceId;
    }
    // 成员退出事件本身（单独成流，不与资源批次混合）
    const withdrawn = this.store.append({
      event_type: "MEMBER_WITHDRAWN",
      aggregate_type: "member_profile",
      aggregate_id: member_id,
      summary: `成员退出：${member.display_name}（${reason}）`,
      actor,
      payload: { member_id, reason, at: at ?? this.now() },
    });
    return [withdrawn, ...results];
  }

  /** 同名消歧：为同名成员分别标注区分信息并留痕（别名/出生年月等，不采集证件号）。 */
  disambiguate({ member_ids, resolution, actor }) {
    const snap = this._snapshot();
    const names = member_ids.map((id) => snap.members.get(id)?.display_name);
    if (new Set(names).size > 1) {
      throw new IllegalState("仅允许对同名成员做消歧标注");
    }
    return this.store.append({
      event_type: "NAME_DISAMBIGUATED",
      aggregate_type: "member_profile",
      aggregate_id: member_ids[0],
      summary: `同名消歧：${names[0]} × ${member_ids.length}`,
      actor,
      payload: { member_ids, resolution },
    });
  }

  // ================= 跨境资格（有权来源） =================
  requestEligibility({ member_id, document_ref, authority, actor }) {
    return this.store.append({
      event_type: "ELIGIBILITY_REQUESTED",
      aggregate_type: "member_eligibility",
      aggregate_id: member_id,
      summary: `资格核验申请：${authority}`,
      actor,
      payload: { member_id, document_ref, authority, state: "requested" },
    });
  }

  confirmEligibility({ member_id, authority, valid_until, source, actor, document_ref }) {
    confirmEligibilityPolicy({ authority, source });
    return this.store.append({
      event_type: "ELIGIBILITY_CONFIRMED",
      aggregate_type: "member_eligibility",
      aggregate_id: member_id,
      summary: `${authority} 确认跨境资格`,
      source, actor,
      payload: {
        member_id, authority, state: "confirmed",
        valid_until, document_ref,
      },
    });
  }

  denyEligibility({ member_id, authority, reason_code, source, actor }) {
    confirmEligibilityPolicy({ authority, source });
    return this.store.append({
      event_type: "ELIGIBILITY_DENIED",
      aggregate_type: "member_eligibility",
      aggregate_id: member_id,
      summary: `${authority} 拒绝跨境资格：${reason_code}`,
      source, actor,
      payload: { member_id, authority, state: "denied", reason_code },
    });
  }

  // ================= 容量资源（并发不超售） =================
  defineResource({ resource_id, kind, capacity, label, actor, source }) {
    return this.store.append({
      event_type: "RESOURCE_DEFINED",
      aggregate_type: "resource",
      aggregate_id: resource_id,
      summary: `建立容量资源：${label}（${capacity}）`,
      actor, source,
      payload: { resource_id, kind, capacity, label },
    });
  }

  /**
   * 占位：容量足够则持有；不足则自动进入候补并给出候补序号。
   * 资源流版本 CAS + 冲突重读重试 => 并发下绝不超售。
   */
  holdOrWaitlist({ resource_id, member_id, quantity = 1, hold_id, actor }) {
    return this._retry(() => {      const snap = this._snapshot();
      const resource = snap.resources.get(resource_id);
      if (!resource) throw new IllegalState(`资源不存在：${resource_id}`);
      const version = this.store.version(resource_id);
      const used = snap.usedCapacity(resource_id);
      const free = resource.capacity - used;
      const base = {
        aggregate_type: "resource",
        aggregate_id: resource_id,
        actor,
        correlation_id: `hold:${hold_id}`,
      };
      if (free >= quantity) {
        return this.store.append(
          {
            ...base,
            event_type: "RESOURCE_HELD",
            summary: `持有 ${resource.label}：${member_id}`,
            payload: {
              hold_id, resource_id, member_id, quantity,
              state: "held", resource_version: version + 1,
            },
          },
          { expectedVersion: version },
        );
      }
      const rank = snap.waitlist(resource_id).length + 1;
      return this.store.append(
        {
          ...base,
          event_type: "WAITLIST_JOINED",
          summary: `候补 ${resource.label}：${member_id}（第 ${rank} 位）`,
          payload: { hold_id, resource_id, member_id, quantity, rank },
        },
        { expectedVersion: version },
      );
    });
  }

  /** 释放占位；若存在候补，按候补顺序自动转正（只转容量允许的部分）。 */
  releaseHold({ hold_id, reason, actor }) {
    return this._retry(() => {
      const snap = this._snapshot();
      const hold = snap.holds.get(hold_id);
      if (!hold) throw new IllegalState(`占位不存在：${hold_id}`);
      if (hold.state === "released") throw new IllegalState(`占位已释放：${hold_id}`);
      const drafts = this._releaseWithPromotions(
        snap, hold, actor, reason, `release:${hold_id}`,
      );
      const version = this.store.version(hold.resource_id);
      return this.store.appendBatch(drafts, {
        expectedVersions: { [hold.resource_id]: version },
      });
    });
  }

  // ================= 多人共用预订 =================
  createBooking(cmd) {
    const { booking_id, kind, group_id, supplier, capacity, contract_ref, actor } = cmd;
    return this.store.append({
      event_type: "BOOKING_CREATED",
      aggregate_type: "booking",
      aggregate_id: booking_id,
      summary: `${kind === "hotel" ? "订房" : "订车"}：${supplier}（${capacity}人）`,
      actor,
      payload: { booking_id, kind, group_id, supplier, capacity, contract_ref },
    });
  }

  attachBookingMember({ booking_id, member_id, actor }) {
    return this._retry(() => {
      const snap = this._snapshot();
      const booking = snap.bookings.get(booking_id);
      if (!booking) throw new IllegalState(`预订不存在：${booking_id}`);
      if (booking.status !== "active") throw new IllegalState("预订已取消");
      if (!booking.members.includes(member_id) && booking.members.length >= booking.capacity) {
        throw new CapacityExceeded(booking_id, 0, booking.capacity + 1);
      }
      const version = this.store.version(booking_id);
      return this.store.append(
        {
          event_type: "BOOKING_MEMBER_ATTACHED",
          aggregate_type: "booking",
          aggregate_id: booking_id,
          summary: `预订 ${booking_id} 挂接成员 ${member_id}`,
          actor,
          payload: { booking_id, member_id },
        },
        { expectedVersion: version },
      );
    });
  }

  detachBookingMember({ booking_id, member_id, reason, actor }) {
    return this.store.append({
      event_type: "BOOKING_MEMBER_DETACHED",
      aggregate_type: "booking",
      aggregate_id: booking_id,
      summary: `预订 ${booking_id} 移除成员 ${member_id}`,
      actor,
      payload: { booking_id, member_id, reason },
    });
  }

  cancelBooking({ booking_id, reason, at, actor }) {
    return this.store.append({
      event_type: "BOOKING_CANCELLED",
      aggregate_type: "booking",
      aggregate_id: booking_id,
      summary: `取消预订 ${booking_id}：${reason}`,
      actor,
      payload: { booking_id, reason, at: at ?? this.now() },
    });
  }

  // ================= 口岸分时与分批 =================
  defineSlot({ slot_id, port_code, direction, start_at, capacity, source, actor }) {
    return this.store.append({
      event_type: "CROSSING_SLOT_DEFINED",
      aggregate_type: "crossing_slot",
      aggregate_id: slot_id,
      summary: `${port_code} ${direction} 时段 ${start_at}（${capacity}人）`,
      source, actor,
      payload: { slot_id, port_code, direction, start_at, capacity },
    });
  }

  changeSlotCapacity({ slot_id, new_capacity, reason, source, actor }) {
    const snap = this._snapshot();
    const slot = snap.slots.get(slot_id);
    if (!slot) throw new IllegalState(`时段不存在：${slot_id}`);
    return this.store.append({
      event_type: "CROSSING_CAPACITY_CHANGED",
      aggregate_type: "crossing_slot",
      aggregate_id: slot_id,
      summary: `${slot.port_code} 限流：${slot.capacity} -> ${new_capacity}`,
      source, actor,
      payload: {
        slot_id, old_capacity: slot.capacity, new_capacity, reason,
      },
    });
  }

  /**
   * 按团队关系提出分批方案（不删除整段行程）：
   * 先整体（团队树前序），整体放不下时按团队子树切分，尽量不拆散同一小队；
   * 必要时安排到相邻后续时段。返回方案草案事件，由调度员确认后落 CROSSING_ASSIGNED。
   */
  proposeBatches({ group_id, slot_id, plan_id, reason, actor }) {
    const snap = this._snapshot();
    const group = snap.groups.get(group_id);
    const slot = snap.slots.get(slot_id);
    if (!group || !slot) throw new IllegalState("团组或时段不存在");
    const members = snap.activeMembers(group_id);
    if (!members.length) throw new IllegalState("团组无在籍成员");

    // 构建团队归属
    const teamOf = new Map(members.map((m) => [m.member_id, m.team_id ?? "_root"]));
    const children = new Map();
    for (const t of group.teams) {
      const parent = t.parent_team_id ?? "_root";
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(t.team_id);
    }
    // 前序展开：父团队的人先过，保持团队关系
    const order = [];
    const walk = (teamId) => {
      members
        .filter((m) => teamOf.get(m.member_id) === teamId)
        .forEach((m) => order.push(m));
      for (const child of children.get(teamId) ?? []) walk(child);
    };
    walk("_root");

    // 可用时段：目标时段 + 同日后续时段（按 start_at 排序）
    const usable = [...snap.slots.values()]
      .filter(
        (s) =>
          s.port_code === slot.port_code &&
          s.direction === slot.direction &&
          Date.parse(s.start_at) >= Date.parse(slot.start_at),
      )
      .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    const remaining = new Map(
      usable.map((s) => [s.slot_id, s.capacity - snap.slotUsed(s.slot_id)]),
    );

    // 按团队子树成块，块不拆分（块大于单时段容量时才退化为按人排）
    const blocks = [];
    const emitBlock = (teamId) => {
      const ids = members.filter((m) => teamOf.get(m.member_id) === teamId).map((m) => m.member_id);
      if (ids.length) blocks.push({ team_id: teamId, member_ids: ids });
      for (const child of children.get(teamId) ?? []) emitBlock(child);
    };
    emitBlock("_root");

    const batches = [];
    let slotCursor = 0;
    for (const block of blocks) {
      let placed = false;
      for (let i = slotCursor; i < usable.length; i += 1) {
        const s = usable[i];
        if (remaining.get(s.slot_id) >= block.member_ids.length) {
          batches.push({ slot_id: s.slot_id, team_id: block.team_id, member_ids: block.member_ids });
          remaining.set(s.slot_id, remaining.get(s.slot_id) - block.member_ids.length);
          placed = true;
          break;
        }
      }
      if (!placed) {
        // 整块放不下：保持块内顺序，按人顺延，绝不删除任何人
        for (const memberId of block.member_ids) {
          let perPlaced = false;
          for (let i = slotCursor; i < usable.length; i += 1) {
            const s = usable[i];
            if (remaining.get(s.slot_id) >= 1) {
              batches.push({ slot_id: s.slot_id, team_id: block.team_id, member_ids: [memberId] });
              remaining.set(s.slot_id, remaining.get(s.slot_id) - 1);
              perPlaced = true;
              break;
            }
          }
          if (!perPlaced) {
            throw new CapacityExceeded(slot.port_code, 0, 1);
          }
        }
      }
      // 游标推进：尽量靠前排，但允许后续块回填前一时段空隙
    }
    // 合并同一时段连续批次的编号
    const bySlot = new Map();
    for (const b of batches) {
      if (!bySlot.has(b.slot_id)) bySlot.set(b.slot_id, bySlot.size + 1);
      b.batch_no = bySlot.get(b.slot_id);
    }

    return this.store.append({
      event_type: "CROSSING_BATCH_PROPOSED",
      aggregate_type: "travel_group",
      aggregate_id: group_id,
      summary: `限流分批方案：${batches.length} 个批次，覆盖 ${members.length} 人`,
      actor,
      correlation_id: `batch:${plan_id}`,
      payload: {
        group_id, plan_id, status: "proposed",
        reason: reason ?? "port_capacity_change",
        batches,
      },
    });
  }

  /** 调度员确认方案：把各批次写入时段占用（多时段多批次，原子提交）。 */
  acceptBatchPlan({ group_id, plan_id, actor }) {
    return this._retry(() => {
      const snap = this._snapshot();
      const plan = snap.groups
        .get(group_id)
        ?.batch_plans.find((x) => x.plan_id === plan_id);
      if (!plan) throw new IllegalState(`方案不存在：${plan_id}`);
      const expected = {};
      for (const slotId of new Set(plan.batches.map((b) => b.slot_id))) {
        expected[slotId] = this.store.version(slotId);
      }
      // 复核容量
      for (const b of plan.batches) {
        const slot = snap.slots.get(b.slot_id);
        const planUse = plan.batches
          .filter((x) => x.slot_id === b.slot_id)
          .reduce((n, x) => n + x.member_ids.length, 0);
        if (snap.slotUsed(b.slot_id) + planUse > slot.capacity) {
          throw new CapacityExceeded(b.slot_id, slot.capacity - snap.slotUsed(b.slot_id), planUse);
        }
      }
      const drafts = [
        {
          event_type: "CROSSING_BATCH_PROPOSED",
          aggregate_type: "travel_group",
          aggregate_id: group_id,
          summary: `分批方案 ${plan_id} 已确认`,
          actor,
          payload: {
            group_id, plan_id, status: "accepted",
            reason: plan.reason, batches: plan.batches,
          },
        },
      ];
      const counts = new Map();
      for (const b of plan.batches) {
        counts.set(b.slot_id, (counts.get(b.slot_id) ?? 0) + b.member_ids.length);
      }
      for (const [slot_id, member_count] of counts) {
        drafts.push({
          event_type: "CROSSING_ASSIGNED",
          aggregate_type: "crossing_slot",
          aggregate_id: slot_id,
          summary: `团组 ${group_id} 时段占用 ${member_count} 人`,
          actor,
          correlation_id: `batch:${plan_id}`,
          payload: {
            slot_id, group_id, member_count,
            batch_no: plan.batches.find((b) => b.slot_id === slot_id).batch_no,
          },
        });
      }
      return this.store.appendBatch(drafts, { expectedVersions: expected });
    });
  }

  rescheduleGroup({ group_id, from_slot_id, to_slot_id, reason, actor }) {
    return this.store.append({
      event_type: "CROSSING_RESCHEDULED",
      aggregate_type: "travel_group",
      aggregate_id: group_id,
      summary: `团组整体改约：${from_slot_id} -> ${to_slot_id}`,
      actor,
      payload: { group_id, from_slot_id, to_slot_id, reason },
    });
  }

  // ================= 合同 / 到访 / 结算 =================
  agreeContract({ contract_id, group_id, party, version, terms, actor }) {
    return this.store.append({
      event_type: "CONTRACT_AGREED",
      aggregate_type: "contract",
      aggregate_id: contract_id,
      summary: `合同 v${version}：${party}`,
      actor,
      payload: { contract_id, group_id, party, version, terms },
    });
  }

  recordAttendance({ proof_id, group_id, member_id, marked_at, marker, proof_ref, source }) {
    recordAttendancePolicy({ source });
    return this.store.append({
      event_type: "ATTENDANCE_RECORDED",
      aggregate_type: "attendance_proof",
      aggregate_id: proof_id,
      summary: `实际到访：${member_id}`,
      source,
      payload: { proof_id, group_id, member_id, marked_at: marked_at ?? this.now(), marker, proof_ref },
    });
  }

  /**
   * 以实际到访为合作结算依据：按合同版本单价 × 实际到访人数结算。
   */
  settleByAttendance({ settlement_id, group_id, contract_id, basis = "actual_attendance", actor }) {
    const snap = this._snapshot();
    const contract = snap.contracts.get(contract_id);
    if (!contract) throw new IllegalState(`合同不存在：${contract_id}`);
    const version = contract.current_version;
    const terms = contract.versions.get(version);
    const attended = snap.attendedMemberIds(group_id);
    // 仅结算到访时仍在籍的成员（退出者另行走取消责任）
    const billable = [...attended].filter(
      (id) => snap.members.get(id)?.group_id === group_id,
    );
    const amount = billable.length * (terms.unit_price ?? 0);
    return this.store.append({
      event_type: "ATTENDANCE_SETTLED",
      aggregate_type: "attendance_proof",
      aggregate_id: settlement_id,
      summary: `按实际到访 ${billable.length} 人结算：${amount}`,
      actor,
      correlation_id: `settle:${settlement_id}`,
      payload: {
        settlement_id, group_id, contract_id, contract_version: version,
        attended_count: billable.length, basis,
        unit_price: terms.unit_price ?? 0, amount,
        member_ids: billable,
      },
    });
  }

  /** 取消责任判定：按变更时点适用当时合同版本。 */
  decideLiability({ contract_id, member_id, changed_at, activity_start_at, actor }) {
    const snap = this._snapshot();
    const contract = snap.contracts.get(contract_id);
    if (!contract) throw new IllegalState(`合同不存在：${contract_id}`);
    const verdict = decideCancellationLiability(
      contract.versions, changed_at, activity_start_at,
    );
    return this.store.append({
      event_type: "CANCELLATION_LIABILITY_DECIDED",
      aggregate_type: "contract",
      aggregate_id: contract_id,
      summary: verdict.liable
        ? `成员 ${member_id} 取消费 ${verdict.fee_pct}%（合同 v${verdict.contractVersion}，${verdict.rule}）`
        : `成员 ${member_id} 免责（${verdict.rule}）`,
      actor,
      payload: {
        contract_id,
        contract_version: verdict.contractVersion ?? null,
        member_id,
        changed_at,
        deadline_at: activity_start_at,
        liable: verdict.liable,
        fee_pct: verdict.fee_pct ?? 0,
        rule: verdict.rule,
      },
    });
  }
}
