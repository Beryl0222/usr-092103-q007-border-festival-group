import { DomainError } from "./events.js";

// 团组与成员：境内外领队各自维护成员资料、语言需求、保险与紧急联系人。
// 容量满后登记进入候补；退出只做状态变更并保留事件过程；同名成员靠身份标识消歧。
export class MemberService {
  constructor(store) {
    this.store = store;
    this.groups = new Map();
    this.members = new Map();
  }

  createGroup({ group_id, program, name_zh, name_ru = null, capacity, contract_id = null, side = "cn" }) {
    if (this.groups.has(group_id)) throw new DomainError(`团组已存在：${group_id}`);
    const group = { group_id, program, name_zh, name_ru, capacity, contract_id, side, waitlist_seq: 0 };
    this.groups.set(group_id, group);
    this.store.append({
      event_type: "GROUP_CREATED",
      aggregate_type: "travel_group",
      aggregate_id: group_id,
      summary: `团组创建：${name_zh}`,
      payload: { program, name_zh, name_ru, capacity, contract_id, side },
    });
    return group;
  }

  getGroup(group_id) {
    const group = this.groups.get(group_id);
    if (!group) throw new DomainError(`团组不存在：${group_id}`);
    return group;
  }

  get(member_id) {
    const member = this.members.get(member_id);
    if (!member) throw new DomainError(`成员不存在：${member_id}`);
    return member;
  }

  registerMember({
    group_id,
    member_id,
    person_id,
    name_zh,
    name_ru = null,
    birth_date = null,
    document_ref = null,
    languages = [],
    insurance = null,
    emergency_contact = null,
    role = "member",
  }) {
    const group = this.getGroup(group_id);
    if (this.members.has(member_id)) throw new DomainError(`成员编号重复：${member_id}`);
    const status = this.activeMembers(group_id).length < group.capacity ? "active" : "waitlisted";
    const member = {
      member_id,
      group_id,
      person_id,
      name_zh,
      name_ru,
      birth_date,
      document_ref,
      languages: [...languages],
      insurance,
      emergency_contact,
      role,
      status,
      waitlist_position: status === "waitlisted" ? ++group.waitlist_seq : null,
    };
    this.members.set(member_id, member);
    this.store.append({
      event_type: status === "active" ? "MEMBER_REGISTERED" : "MEMBER_WAITLISTED",
      aggregate_type: "group_member",
      aggregate_id: member_id,
      summary: status === "active" ? `成员登记：${name_zh}` : `候补登记：${name_zh}`,
      payload: { group_id, person_id, name_zh, name_ru, role, status, waitlist_position: member.waitlist_position },
    });
    return member;
  }

  updateMember(member_id, patch) {
    const member = this.get(member_id);
    if (member.status === "withdrawn") throw new DomainError(`成员已退出，不能更新：${member_id}`);
    const allowed = ["name_ru", "birth_date", "document_ref", "languages", "insurance", "emergency_contact", "role"];
    const changed = [];
    for (const key of allowed) {
      if (key in patch) {
        member[key] = patch[key];
        changed.push(key);
      }
    }
    if (!changed.length) throw new DomainError("没有可更新的字段");
    // 证件细节不写入事件载荷，只记录被更新的字段名
    this.store.append({
      event_type: "MEMBER_UPDATED",
      aggregate_type: "group_member",
      aggregate_id: member_id,
      summary: `成员资料更新：${member.name_zh}`,
      payload: { group_id: member.group_id, fields: changed },
    });
    return member;
  }

  withdrawMember(member_id, { reason = null } = {}) {
    const member = this.get(member_id);
    if (member.status === "withdrawn") throw new DomainError(`成员已退出：${member_id}`);
    const previous_status = member.status;
    member.status = "withdrawn";
    const event = this.store.append({
      event_type: "MEMBER_WITHDRAWN",
      aggregate_type: "group_member",
      aggregate_id: member_id,
      summary: `成员退出：${member.name_zh}`,
      payload: { group_id: member.group_id, previous_status, reason },
    });
    return { event, previous_status };
  }

  promoteWaitlist(group_id, { freed_by = null } = {}) {
    const group = this.getGroup(group_id);
    const next = this.waitlistedMembers(group_id)[0];
    if (!next) return null;
    if (this.activeMembers(group_id).length >= group.capacity) return null;
    const position = next.waitlist_position;
    next.status = "active";
    next.waitlist_position = null;
    return this.store.append({
      event_type: "WAITLIST_PROMOTED",
      aggregate_type: "group_member",
      aggregate_id: next.member_id,
      summary: `候补转正：${next.name_zh}`,
      payload: { group_id, freed_by, waitlist_position: position },
    });
  }

  // 同名消歧：只暴露非敏感区分项（身份标识、出生年份、证件尾号），供调度员人工确认
  disambiguate(group_id, name_zh) {
    return this.allOfGroup(group_id)
      .filter((m) => m.name_zh === name_zh && m.status !== "withdrawn")
      .map((m) => ({
        member_id: m.member_id,
        person_id: m.person_id,
        name_zh: m.name_zh,
        birth_year: m.birth_date ? m.birth_date.slice(0, 4) : null,
        document_tail: m.document_ref ? m.document_ref.slice(-2) : null,
        status: m.status,
      }));
  }

  allOfGroup(group_id) {
    return [...this.members.values()].filter((m) => m.group_id === group_id);
  }

  activeMembers(group_id) {
    return this.allOfGroup(group_id).filter((m) => m.status === "active");
  }

  waitlistedMembers(group_id) {
    return this.allOfGroup(group_id)
      .filter((m) => m.status === "waitlisted")
      .sort((a, b) => a.waitlist_position - b.waitlist_position);
  }

  history(member_id) {
    return this.store.ofAggregate("group_member", member_id);
  }
}
