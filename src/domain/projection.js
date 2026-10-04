/**
 * 读模型投影：从事件日志重放出当前状态。
 * 投影只追加、不做权限判断；对外清单的字段裁剪由 views 模块负责。
 */

export class Projection {
  constructor() {
    this.groups = new Map(); // group_id
    this.members = new Map(); // member_id
    this.eligibility = new Map(); // member_id
    this.resources = new Map(); // resource_id
    this.holds = new Map(); // hold_id
    this.bookings = new Map(); // booking_id
    this.slots = new Map(); // slot_id
    this.contracts = new Map(); // contract_id -> {versions: Map, current}
    this.attendance = new Map(); // key group_id:member_id -> proof
    this.exports_ = new Map(); // export_id
    this.audit = [];
    /** 过程留痕：每个关键聚合的来源事件 */
    this.trace = new Map(); // key -> events[]
  }

  static build(store) {
    const p = new Projection();
    for (const e of store.readAll()) p.apply(e);
    return p;
  }

  _trace(key, event) {
    const list = this.trace.get(key) ?? [];
    list.push(event);
    this.trace.set(key, list);
  }

  apply(e) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      // —— 团组 ——
      case "GROUP_CREATED":
        this.groups.set(p.group_id, {
          group_id: p.group_id,
          activity_kind: p.activity_kind,
          name: p.name,
          leaders: {},
          teams: [],
          batch_plans: [],
          reschedules: [],
          created_at: e.occurred_at,
        });
        break;
      case "GROUP_UPDATED": {
        const g = this.groups.get(p.group_id);
        if (g) Object.assign(g, p.changes);
        break;
      }
      case "LEADER_ASSIGNED": {
        const g = this.groups.get(p.group_id);
        if (g) g.leaders[p.side] = { leader_id: p.leader_id, name: p.leader_name };
        break;
      }
      case "TEAM_DEFINED": {
        const g = this.groups.get(p.group_id);
        if (g && !g.teams.some((t) => t.team_id === p.team_id)) {
          g.teams.push({
            team_id: p.team_id,
            team_name: p.team_name,
            parent_team_id: p.parent_team_id ?? null,
            kind: p.kind ?? null,
          });
        }
        break;
      }
      case "CROSSING_BATCH_PROPOSED": {
        const g = this.groups.get(p.group_id);
        if (g) {
          g.batch_plans.forEach((plan) => {
            if (plan.plan_id !== p.plan_id && plan.status === "proposed") {
              plan.status = "superseded";
            }
          });
          g.batch_plans.push({
            plan_id: p.plan_id,
            status: p.status,
            batches: p.batches,
            reason: p.reason ?? null,
            at: e.occurred_at,
          });
        }
        break;
      }
      case "CROSSING_RESCHEDULED": {
        const g = this.groups.get(p.group_id);
        if (g) g.reschedules.push({ ...p, at: e.occurred_at });
        break;
      }

      // —— 成员 ——
      case "MEMBER_REGISTERED":
        this.members.set(p.member_id, {
          member_id: p.member_id,
          group_id: p.group_id,
          team_id: p.team_id ?? null,
          side: p.side,
          display_name: p.display_name,
          aliases: [],
          languages: p.languages ?? [],
          needs_interpreter: p.needs_interpreter ?? false,
          role: p.role ?? "participant",
          dietary: p.dietary ?? null,
          phone: p.phone ?? null,
          emergency_contact: p.emergency_contact ?? null,
          insurance: p.insurance ?? null,
          status: "active",
          registered_at: e.occurred_at,
          withdrawals: [],
        });
        break;
      case "MEMBER_PROFILE_UPDATED": {
        const m = this.members.get(p.member_id);
        if (m) {
          if (p.changes.aliases) {
            m.aliases = [...new Set([...m.aliases, ...p.changes.aliases])];
            delete p.changes.aliases;
          }
          Object.assign(m, p.changes);
        }
        break;
      }
      case "MEMBER_WITHDRAWN": {
        const m = this.members.get(p.member_id);
        if (m) {
          m.status = "withdrawn";
          m.withdrawals.push({ reason: p.reason, at: p.at });
        }
        break;
      }
      case "NAME_DISAMBIGUATED": {
        for (const [memberId, note] of Object.entries(p.resolution)) {
          const m = this.members.get(memberId);
          if (m) m.disambiguation = { note, at: e.occurred_at, by: e.actor?.id };
        }
        p.member_ids.forEach((id) => this._trace(`disambig:${id}`, e));
        break;
      }

      // —— 资格 ——
      case "ELIGIBILITY_REQUESTED":
      case "ELIGIBILITY_CONFIRMED":
      case "ELIGIBILITY_DENIED": {
        const prev = this.eligibility.get(p.member_id) ?? { history: [] };
        const next = {
          ...prev,
          member_id: p.member_id,
          state: p.state ?? "requested",
          authority: p.authority,
          document_ref: p.document_ref ?? prev.document_ref,
          valid_until: p.valid_until ?? prev.valid_until,
          reason_code: p.reason_code ?? prev.reason_code,
          source: e.source,
          updated_at: e.occurred_at,
        };
        next.history = [
          ...prev.history,
          { state: next.state, at: e.occurred_at, source: e.source?.id, reason: p.reason_code },
        ];
        this.eligibility.set(p.member_id, next);
        this._trace(`eligibility:${p.member_id}`, e);
        break;
      }

      // —— 资源 ——
      case "RESOURCE_DEFINED":
        this.resources.set(p.resource_id, {
          resource_id: p.resource_id,
          kind: p.kind,
          label: p.label,
          capacity: p.capacity,
          holds: [],
        });
        break;
      case "RESOURCE_HELD":
      case "WAITLIST_JOINED": {
        const r = this.resources.get(p.resource_id);
        const hold = {
          hold_id: p.hold_id,
          resource_id: p.resource_id,
          member_id: p.member_id,
          quantity: p.quantity,
          state: e.event_type === "WAITLIST_JOINED" ? "waitlisted" : p.state,
          rank: p.rank ?? null,
          resource_version: p.resource_version,
          since: e.occurred_at,
        };
        this.holds.set(p.hold_id, hold);
        r?.holds.push(hold);
        this._trace(`hold:${p.hold_id}`, e);
        break;
      }
      case "WAITLIST_PROMOTED": {
        const h = this.holds.get(p.hold_id);
        if (h) {
          h.state = "held";
          h.rank = null;
          h.promoted_at = e.occurred_at;
          h.resource_version = p.resource_version;
        }
        this._trace(`hold:${p.hold_id}`, e);
        break;
      }
      case "HOLD_RELEASED": {
        const h = this.holds.get(p.hold_id);
        if (h) {
          h.state = "released";
          h.released_reason = p.reason;
          h.released_at = e.occurred_at;
        }
        this._trace(`hold:${p.hold_id}`, e);
        break;
      }

      // —— 预订 ——
      case "BOOKING_CREATED":
        this.bookings.set(p.booking_id, {
          booking_id: p.booking_id,
          kind: p.kind,
          group_id: p.group_id,
          supplier: p.supplier,
          capacity: p.capacity,
          contract_ref: p.contract_ref,
          members: [],
          status: "active",
          history: [{ type: "created", at: e.occurred_at }],
        });
        break;
      case "BOOKING_MEMBER_ATTACHED": {
        const b = this.bookings.get(p.booking_id);
        if (b && !b.members.includes(p.member_id)) b.members.push(p.member_id);
        b?.history.push({ type: "attached", member_id: p.member_id, at: e.occurred_at });
        this._trace(`booking:${p.booking_id}:${p.member_id}`, e);
        break;
      }
      case "BOOKING_MEMBER_DETACHED": {
        const b = this.bookings.get(p.booking_id);
        if (b) b.members = b.members.filter((id) => id !== p.member_id);
        b?.history.push({
          type: "detached",
          member_id: p.member_id,
          reason: p.reason,
          at: e.occurred_at,
        });
        this._trace(`booking:${p.booking_id}:${p.member_id}`, e);
        break;
      }
      case "BOOKING_CANCELLED": {
        const b = this.bookings.get(p.booking_id);
        if (b) {
          b.status = "cancelled";
          b.cancel_reason = p.reason;
          b.cancelled_at = p.at;
          b.history.push({ type: "cancelled", reason: p.reason, at: p.at });
        }
        break;
      }

      // —— 口岸 ——
      case "CROSSING_SLOT_DEFINED":
        this.slots.set(p.slot_id, {
          slot_id: p.slot_id,
          port_code: p.port_code,
          direction: p.direction,
          start_at: p.start_at,
          capacity: p.capacity,
          assignments: [],
          capacity_history: [],
        });
        break;
      case "CROSSING_CAPACITY_CHANGED": {
        const s = this.slots.get(p.slot_id);
        if (s) {
          s.capacity_history.push({
            from: p.old_capacity,
            to: p.new_capacity,
            reason: p.reason,
            at: e.occurred_at,
          });
          s.capacity = p.new_capacity;
        }
        break;
      }
      case "CROSSING_ASSIGNED": {
        const s = this.slots.get(p.slot_id);
        s?.assignments.push({
          group_id: p.group_id,
          member_count: p.member_count,
          batch_no: p.batch_no,
          at: e.occurred_at,
        });
        break;
      }

      // —— 合同与结算 ——
      case "CONTRACT_AGREED": {
        const rec = this.contracts.get(p.contract_id) ?? {
          contract_id: p.contract_id,
          group_id: p.group_id,
          versions: new Map(),
        };
        rec.versions.set(p.version, { ...p.terms, party: p.party, agreed_at: e.occurred_at });
        rec.current_version = p.version;
        this.contracts.set(p.contract_id, rec);
        break;
      }
      case "ATTENDANCE_RECORDED": {
        this.attendance.set(`${p.group_id}:${p.member_id}`, {
          group_id: p.group_id,
          member_id: p.member_id,
          marked_at: p.marked_at,
          marker: p.marker,
          proof_ref: p.proof_ref,
        });
        break;
      }
      case "ATTENDANCE_SETTLED":
        this.settlement = { ...p, at: e.occurred_at };
        break;
      case "CANCELLATION_LIABILITY_DECIDED":
        this._trace(`liability:${p.contract_id}:${p.member_id}`, e);
        break;

      // —— 导出 ——
      case "EXPORT_ISSUED":
        this.exports_.set(p.export_id, { ...p, status: "valid", revoked: null });
        break;
      case "EXPORT_REVOKED": {
        const x = this.exports_.get(p.export_id);
        if (x) {
          x.status = "revoked";
          x.revoked = { at: p.revoked_at, reason: p.reason };
        }
        break;
      }
      case "AUDIT_RECORDED":
        this.audit.push({ ...p, at: p.at });
        break;
    }
  }

  // —— 查询辅助 ——
  activeMembers(groupId) {
    return [...this.members.values()].filter(
      (m) => m.group_id === groupId && m.status === "active",
    );
  }

  /** 资源已占用量（不含已释放/候补）。 */
  usedCapacity(resourceId) {
    return [...this.holds.values()]
      .filter((h) => h.resource_id === resourceId && h.state === "held")
      .reduce((sum, h) => sum + h.quantity, 0);
  }

  waitlist(resourceId) {
    return [...this.holds.values()]
      .filter((h) => h.resource_id === resourceId && h.state === "waitlisted")
      .sort((a, b) => a.rank - b.rank);
  }

  slotUsed(slotId) {
    return (this.slots.get(slotId)?.assignments ?? []).reduce(
      (sum, a) => sum + a.member_count,
      0,
    );
  }

  attendedMemberIds(groupId) {
    return new Set(
      [...this.attendance.values()]
        .filter((a) => a.group_id === groupId)
        .map((a) => a.member_id),
    );
  }
}
