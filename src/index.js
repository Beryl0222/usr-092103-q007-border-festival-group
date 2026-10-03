import { EventStore } from "./events.js";
import { MemberService } from "./members.js";
import { EligibilityService } from "./eligibility.js";
import { InventoryService } from "./inventory.js";
import { CrossingService } from "./crossing.js";
import { ContractService } from "./contracts.js";
import { SettlementService } from "./settlement.js";
import { ExportService } from "./exports.js";
import { RiskService } from "./risk.js";

// 系统装配：共享一个事件存储，成员退出时联动取消责任核定与候补转正。
export function createSystem({ now } = {}) {
  let current = now ?? (() => new Date().toISOString());
  const clock = {
    now: () => (typeof current === "function" ? current() : current),
    set: (value) => {
      current = value;
    },
  };

  const store = new EventStore({ now: clock.now });
  const members = new MemberService(store);
  const eligibility = new EligibilityService(store);
  const inventory = new InventoryService(store);
  const crossing = new CrossingService(store, members);
  const contracts = new ContractService(store);
  const settlement = new SettlementService(store, contracts, members);
  const exportService = new ExportService(store, members, inventory, eligibility);
  const risk = new RiskService({ members, eligibility, inventory, crossing, exportService });

  // 退出编排：状态变更 → 按变更时点和合同版本核定取消责任 → 候补按序转正
  function withdrawMember(member_id, { reason = null, activity_id = null, activity_start = null } = {}) {
    const member = members.get(member_id);
    const group = members.getGroup(member.group_id);
    const { event, previous_status } = members.withdrawMember(member_id, { reason });
    let assessment = null;
    if (previous_status === "active" && activity_start && group.contract_id && contracts.has(group.contract_id)) {
      assessment = settlement.assessCancellation({
        member_id,
        group,
        activity_id,
        activity_start,
        occurred_at: event.occurred_at,
      });
    }
    const promotion = members.promoteWaitlist(member.group_id, { freed_by: member_id });
    return { withdrawal: event, assessment, promotion };
  }

  return {
    store,
    clock,
    members,
    eligibility,
    inventory,
    crossing,
    contracts,
    settlement,
    exports: exportService,
    risk,
    withdrawMember,
  };
}
