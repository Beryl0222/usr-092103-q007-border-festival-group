import { AuthorizationError } from "./events.js";

// 跨境资格：只接受已登记的有权来源（如口岸边防、外事部门）按确认类型与项目范围确认。
// 事件载荷只保留状态与来源引用，不记录证件号码等细节。
export class EligibilityService {
  constructor(store) {
    this.store = store;
    this.sources = new Map();
  }

  registerSource({ source_id, authority, kinds, programs }) {
    this.sources.set(source_id, { source_id, authority, kinds: [...kinds], programs: [...programs] });
  }

  confirm({ member_id, program, kind, source_id, valid_until = null, note = null, occurred_at = null }) {
    const source = this.#authorize(source_id, kind, program);
    return this.store.append({
      event_type: "ELIGIBILITY_CONFIRMED",
      aggregate_type: "member_eligibility",
      aggregate_id: member_id,
      summary: `跨境资格确认：${member_id}（${kind}）`,
      payload: { member_id, program, kind, source_id, authority: source.authority, result: "confirmed", valid_until, note },
      occurred_at,
    });
  }

  revoke({ member_id, program, kind, source_id, reason = null }) {
    const source = this.#authorize(source_id, kind, program);
    return this.store.append({
      event_type: "ELIGIBILITY_REVOKED",
      aggregate_type: "member_eligibility",
      aggregate_id: member_id,
      summary: `跨境资格撤销：${member_id}（${kind}）`,
      payload: { member_id, program, kind, source_id, authority: source.authority, result: "revoked", reason },
    });
  }

  #authorize(source_id, kind, program) {
    const source = this.sources.get(source_id);
    if (!source) throw new AuthorizationError(`无权确认来源：${source_id}`);
    if (!source.kinds.includes(kind)) throw new AuthorizationError(`来源 ${source_id} 无权确认类型 ${kind}`);
    if (!source.programs.includes(program)) throw new AuthorizationError(`来源 ${source_id} 无权确认项目 ${program}`);
    return source;
  }

  status(member_id, kind) {
    const events = this.store.ofAggregate("member_eligibility", member_id).filter((e) => e.payload.kind === kind);
    if (!events.length) return "missing";
    return events.at(-1).payload.result === "confirmed" ? "confirmed" : "revoked";
  }
}
