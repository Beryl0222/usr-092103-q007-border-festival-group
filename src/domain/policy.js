/**
 * 领域策略：有权来源、字段最小化、取消责任判定。
 * 策略函数保持纯粹，便于单测；命令层负责调用并留痕。
 */
import { DomainError } from "./store.js";

export class Unauthorized extends DomainError {
  constructor(message) {
    super(message);
    this.code = "UNAUTHORIZED";
  }
}

/** 跨境资格确认/拒绝只接受以下有权来源；旅行社、合作方等一律无权。 */
const ELIGIBILITY_AUTHORITIES = {
  port_entry: "port_authority",
  consulate: "consular_authority",
};

export function confirmEligibilityPolicy({ authority, source }) {
  const required = ELIGIBILITY_AUTHORITIES[authority];
  if (!required) {
    throw new Unauthorized(`未知的资格审批机关：${authority}`);
  }
  if (!source || source.kind !== required) {
    throw new Unauthorized(
      `资格机关 ${authority} 只接受来源 ${required} 的确认，实际来源：${source?.kind ?? "无"}`,
    );
  }
}

export const ATTENDANCE_SOURCES = new Set([
  "port_authority",
  "festival_dispatch",
  "system",
]);

export function recordAttendancePolicy({ source }) {
  if (!source || !ATTENDANCE_SOURCES.has(source.kind)) {
    throw new Unauthorized(
      `实际到访只采信口岸/现场核验来源，实际来源：${source?.kind ?? "无"}`,
    );
  }
}

/** 领队只能维护本方成员；调度员可操作全部。 */
export function memberSidePolicy({ actor, member, action }) {
  if (actor.role === "dispatcher" || actor.role === "system") return;
  if (actor.role !== "leader") {
    throw new Unauthorized(`角色 ${actor.role} 无权${action}成员`);
  }
  if (actor.side !== member.side) {
    throw new Unauthorized(
      `${actor.side} 方领队无权${action} ${member.side} 方成员 ${member.member_id}`,
    );
  }
}

/**
 * 字段最小化：按接收方类型与用途决定可外发字段。
 * 证件号码从不进入交换事件（只有 document_ref 句柄），保险单号等细节按用途放行。
 */
export const FIELD_GROUPS = {
  identity: ["member_id", "display_name", "aliases", "side"],
  team: ["team_id", "team_name"],
  needs: ["languages", "needs_interpreter", "dietary", "accessibility"],
  eligibility: ["eligibility_state"],
  logistics: ["bookings", "holds", "crossing_batch"],
  contact: ["phone", "emergency_contact"],
  insurance: ["insurance"],
  document_ref: ["document_ref"],
};

const PURPOSE_POLICY = {
  // 酒店前台：入住所需
  hotel_checkin: {
    allow: ["identity", "team", "logistics"],
  },
  // 车队：只需要人数与团队归属
  transport: {
    allow: ["identity", "team", "logistics"],
  },
  // 演出/赛事席位方
  seat_manifest: {
    allow: ["identity", "team", "needs", "eligibility", "logistics"],
  },
  // 口岸通行
  border_manifest: {
    allow: ["identity", "team", "eligibility", "document_ref", "logistics"],
  },
  // 保险核验
  insurance_verification: {
    allow: ["identity", "insurance", "contact"],
  },
  // 领队自用清单：本方全量
  leader_roster: {
    allow: [
      "identity",
      "team",
      "needs",
      "eligibility",
      "logistics",
      "contact",
      "insurance",
      "document_ref",
    ],
  },
  // 调度员风险视图
  dispatch: {
    allow: [
      "identity",
      "team",
      "needs",
      "eligibility",
      "logistics",
      "contact",
      "insurance",
      "document_ref",
    ],
  },
};

export function allowedFields(purpose) {
  const policy = PURPOSE_POLICY[purpose];
  if (!policy) throw new Unauthorized(`未登记的导出用途：${purpose}`);
  return policy.allow.flatMap((group) => FIELD_GROUPS[group]);
}

export function redact(record, purpose) {
  const allow = new Set(allowedFields(purpose));
  const out = {};
  for (const key of Object.keys(record)) {
    if (allow.has(key)) out[key] = record[key];
  }
  return out;
}

/**
 * 取消责任：按“变更时点”选择当时有效的合同版本，再按该版本的阶梯条款判定。
 * @param {Map<number, object>} versions version -> terms(agreed_at, cancel_tiers, no_show_pct)
 * @param {string} changedAt 成员变更（退出）时点
 * @param {string} activityStartAt 活动开始/最晚免责截止时点
 */
export function decideCancellationLiability(versions, changedAt, activityStartAt) {
  const agreed = [...versions.entries()]
    .filter(([, t]) => Date.parse(t.agreed_at) <= Date.parse(changedAt))
    .sort((a, b) => b[0] - a[0]);
  if (!agreed.length) {
    return { liable: false, fee_pct: 0, rule: "no_contract_at_change_time" };
  }
  const [contractVersion, terms] = agreed[0];
  const hoursBefore =
    (Date.parse(activityStartAt) - Date.parse(changedAt)) / 3_600_000;

  if (hoursBefore < 0) {
    return {
      contractVersion,
      liable: (terms.no_show_pct ?? 100) > 0,
      fee_pct: terms.no_show_pct ?? 100,
      hours_before: Number(hoursBefore.toFixed(2)),
      rule: "no_show",
    };
  }
  const tiers = [...(terms.cancel_tiers ?? [])].sort(
    (a, b) => b.before_hours - a.before_hours,
  );
  const hit = tiers.find((t) => hoursBefore >= t.before_hours);
  const feePct = hit ? hit.fee_pct : terms.no_show_pct ?? 100;
  return {
    contractVersion,
    liable: feePct > 0,
    fee_pct: feePct,
    hours_before: Number(hoursBefore.toFixed(2)),
    rule: hit ? `tier_${hit.before_hours}h` : "within_shortest_tier",
  };
}
