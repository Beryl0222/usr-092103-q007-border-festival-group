/**
 * 对外视图：成员记录拼装、双语清单、调度员风险面板、导出台账。
 * 所有外发数据都经过 policy.redact 按用途最小化；证件细节不外传。
 */
import { redact, allowedFields } from "./policy.js";

export const I18N = {
  zh: {
    chorus: "中俄合唱交流",
    sports_games: "体育大会",
    trade_fair: "口岸贸易活动",
    domestic: "中方",
    foreign: "俄方",
    headers: {
      member_id: "成员编号",
      display_name: "姓名",
      side: "方别",
      team_name: "团队",
      languages: "语言",
      needs_interpreter: "需翻译",
      dietary: "餐饮",
      eligibility_state: "跨境资格",
      document_ref: "资格凭据编号",
      bookings: "住宿/用车",
      holds: "席位车位",
      crossing_batch: "口岸批次",
      phone: "电话",
      emergency_contact: "紧急联系人",
      insurance: "保险",
      aliases: "别名",
    },
    eligibility: { requested: "核验中", confirmed: "已确认", denied: "已拒绝" },
    yes: "是",
    no: "否",
  },
  ru: {
    chorus: "Китайско-российский хоровой обмен",
    sports_games: "Спортивные игры",
    trade_fair: "Приграничная торговая ярмарка",
    domestic: "Китай",
    foreign: "Россия",
    headers: {
      member_id: "№ участника",
      display_name: "ФИО",
      side: "Сторона",
      team_name: "Команда",
      languages: "Языки",
      needs_interpreter: "Переводчик",
      dietary: "Питание",
      eligibility_state: "Допуск",
      document_ref: "№ допуска",
      bookings: "Отель/транспорт",
      holds: "Места",
      crossing_batch: "Партия на границе",
      phone: "Телефон",
      emergency_contact: "Экстренный контакт",
      insurance: "Страховка",
      aliases: "Иные имена",
    },
    eligibility: { requested: "проверяется", confirmed: "подтверждён", denied: "отклонён" },
    yes: "да",
    no: "нет",
  },
};

export class Views {
  constructor(projection, { now } = {}) {
    this.p = projection;
    this.now = now ?? (() => new Date());
  }

  _teamName(teamId) {
    if (!teamId) return null;
    for (const g of this.p.groups.values()) {
      const t = g.teams.find((x) => x.team_id === teamId);
      if (t) return t.team_name;
    }
    return teamId;
  }

  /** 拼装单个成员的完整内部记录（含敏感字段，仅供最小化前使用）。 */
  memberRecord(memberId) {
    const m = this.p.members.get(memberId);
    if (!m) return null;
    const elig = this.p.eligibility.get(memberId);
    const bookings = [...this.p.bookings.values()]
      .filter((b) => b.status === "active" && b.members.includes(memberId))
      .map((b) => ({ booking_id: b.booking_id, kind: b.kind, supplier: b.supplier }));
    const holds = [...this.p.holds.values()]
      .filter((h) => h.member_id === memberId && h.state !== "released")
      .map((h) => ({
        hold_id: h.hold_id,
        resource_id: h.resource_id,
        state: h.state,
        rank: h.rank,
      }));
    const group = this.p.groups.get(m.group_id);
    let crossingBatch = null;
    const plan = group?.batch_plans.find((x) => x.status === "accepted")
      ?? group?.batch_plans.find((x) => x.status === "proposed");
    if (plan) {
      const found = plan.batches.find((b) => b.member_ids.includes(memberId));
      if (found) {
        const slot = this.p.slots.get(found.slot_id);
        crossingBatch = {
          plan_id: plan.plan_id,
          batch_no: found.batch_no,
          slot_id: found.slot_id,
          port_code: slot?.port_code,
          start_at: slot?.start_at,
          status: plan.status,
        };
      }
    }
    return {
      member_id: m.member_id,
      display_name: m.display_name,
      aliases: m.aliases,
      side: m.side,
      team_id: m.team_id,
      team_name: this._teamName(m.team_id),
      languages: m.languages,
      needs_interpreter: m.needs_interpreter,
      dietary: m.dietary,
      status: m.status,
      eligibility_state: elig?.state ?? "none",
      document_ref: elig?.document_ref ?? null,
      bookings,
      holds,
      crossing_batch: crossingBatch,
      phone: m.phone ?? null,
      emergency_contact: m.emergency_contact ?? null,
      insurance: m.insurance ?? null,
    };
  }

  /**
   * 领队双语清单：默认只含本方成员，按用途做字段最小化。
   * @returns {{zh: object, ru: object}} 两种语言各自的清单
   */
  leaderRoster({ group_id, side, purpose = "leader_roster" }) {
    const records = this.p
      .activeMembers(group_id)
      .filter((m) => m.side === side)
      .map((m) => this.memberRecord(m.member_id))
      .map((r) => redact(r, purpose));
    return {
      zh: this._localize(records, "zh"),
      ru: this._localize(records, "ru"),
    };
  }

  _localize(records, lang) {
    const t = I18N[lang];
    return records.map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        // 只输出有双语表头的字段，内部键（如 team_id）不外显
        if (!(k in t.headers)) continue;
        const label = t.headers[k];
        let value = v;
        if (k === "side") value = t[v] ?? v;
        if (k === "eligibility_state") value = t.eligibility[v] ?? v;
        if (k === "needs_interpreter") value = v ? t.yes : t.no;
        if (Array.isArray(v) && (k === "languages" || k === "aliases")) {
          value = v.join("/");
        }
        if (Array.isArray(v) && (k === "bookings" || k === "holds")) {
          value = v.map((x) => x.supplier ?? x.resource_id ?? x.hold_id).join(", ");
        }
        if (v && typeof v === "object" && k === "crossing_batch") {
          value = `${v.port_code ?? v.slot_id} ${v.start_at ?? ""} #${v.batch_no}`;
        }
        out[label] = value;
      }
      return out;
    });
  }

  /**
   * 调度员整体风险面板。
   */
  riskBoard(now = new Date().toISOString()) {
    const board = {
      generated_at: now,
      groups: [],
      capacity_risks: [],
      waitlists: [],
      eligibility_risks: [],
      crossing_risks: [],
      booking_risks: [],
      export_risks: [],
    };
    for (const group of this.p.groups.values()) {
      const members = this.p.activeMembers(group.group_id);
      const withdrawn = [...this.p.members.values()].filter(
        (m) => m.group_id === group.group_id && m.status === "withdrawn",
      ).length;
      const needInterpreter = members.filter((m) => m.needs_interpreter).length;
      const unconfirmed = members.filter((m) => {
        const s = this.p.eligibility.get(m.member_id)?.state;
        return s !== "confirmed";
      });
      board.groups.push({
        group_id: group.group_id,
        name: group.name,
        activity_kind: group.activity_kind,
        active: members.length,
        withdrawn,
        need_interpreter: needInterpreter,
        eligibility_unconfirmed: unconfirmed.length,
        leaders: group.leaders,
        latest_batch_plan: group.batch_plans.at(-1)?.plan_id ?? null,
      });
      for (const m of unconfirmed) {
        board.eligibility_risks.push({
          group_id: group.group_id,
          member_id: m.member_id,
          display_name: m.display_name,
          state: this.p.eligibility.get(m.member_id)?.state ?? "not_requested",
        });
      }
    }
    // 容量：超售为 0 容忍（系统层面不可能），面板报告高占用与候补
    for (const r of this.p.resources.values()) {
      const used = this.p.usedCapacity(r.resource_id);
      const waiting = this.p.waitlist(r.resource_id);
      if (used > r.capacity) {
        board.capacity_risks.push({
          resource_id: r.resource_id, label: r.label,
          used, capacity: r.capacity, severity: "oversold",
        });
      } else if (used === r.capacity) {
        board.capacity_risks.push({
          resource_id: r.resource_id, label: r.label,
          used, capacity: r.capacity, severity: "full",
        });
      }
      waiting.forEach((h) => {
        board.waitlists.push({
          resource_id: r.resource_id, label: r.label,
          hold_id: h.hold_id, member_id: h.member_id, rank: h.rank,
        });
      });
    }
    // 预订容量
    for (const b of this.p.bookings.values()) {
      if (b.status !== "active") continue;
      if (b.members.length > b.capacity) {
        board.booking_risks.push({
          booking_id: b.booking_id, supplier: b.supplier,
          used: b.members.length, capacity: b.capacity, severity: "oversold",
        });
      } else if (b.members.length === b.capacity) {
        board.booking_risks.push({
          booking_id: b.booking_id, supplier: b.supplier,
          used: b.members.length, capacity: b.capacity, severity: "full",
        });
      }
    }
    // 口岸时段
    for (const s of this.p.slots.values()) {
      const used = this.p.slotUsed(s.slot_id);
      if (used > s.capacity) {
        board.crossing_risks.push({
          slot_id: s.slot_id, port_code: s.port_code,
          used, capacity: s.capacity, severity: "oversold",
        });
      }
      if (s.capacity_history.length) {
        board.crossing_risks.push({
          slot_id: s.slot_id, port_code: s.port_code,
          capacity: s.capacity, latest_change: s.capacity_history.at(-1),
          severity: "capacity_changed",
        });
      }
    }
    // 导出失效
    for (const x of this.p.exports_.values()) {
      if (x.status === "revoked") {
        board.export_risks.push({ export_id: x.export_id, status: "revoked" });
      } else if (Date.parse(x.expires_at) <= Date.parse(now)) {
        board.export_risks.push({
          export_id: x.export_id, status: "expired",
          recipient: x.recipient, expires_at: x.expires_at,
        });
      }
    }
    return board;
  }

  /**
   * 生成外发数据集（先最小化），供导出台账记录字段与条数。
   */
  buildExportDataset({ group_id, side = null, purpose }) {
    let members = this.p.activeMembers(group_id);
    if (side) members = members.filter((m) => m.side === side);
    const fields = new Set();
    const rows = members.map((m) => {
      const row = redact(this.memberRecord(m.member_id), purpose);
      Object.keys(row).forEach((f) => fields.add(f));
      return row;
    });
    return { rows, fields: [...fields], allowed_fields: allowedFields(purpose) };
  }
}
