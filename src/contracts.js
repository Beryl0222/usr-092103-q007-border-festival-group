import { DomainError } from "./events.js";

// 合作合同按版本生效：同一合同可发布多个版本，判定责任时取变更时点已生效的最新版本。
export class ContractService {
  constructor(store) {
    this.store = store;
    this.contracts = new Map();
  }

  publish({ contract_id, version, partner_id, program, price_per_member_cents, currency = "CNY", cancellation_tiers, effective_from }) {
    const list = this.contracts.get(contract_id) ?? [];
    if (list.some((c) => c.version === version)) throw new DomainError(`合同版本已存在：${contract_id} v${version}`);
    const contract = {
      contract_id,
      version,
      partner_id,
      program,
      price_per_member_cents,
      currency,
      cancellation_tiers: [...cancellation_tiers].sort((a, b) => b.min_hours_before - a.min_hours_before),
      effective_from,
    };
    list.push(contract);
    this.contracts.set(contract_id, list);
    this.store.append({
      event_type: "CONTRACT_PUBLISHED",
      aggregate_type: "contract",
      aggregate_id: contract_id,
      summary: `合同发布：${contract_id} v${version}`,
      payload: { version, partner_id, program, price_per_member_cents, currency, cancellation_tiers, effective_from },
    });
    return contract;
  }

  has(contract_id) {
    return this.contracts.has(contract_id);
  }

  versionAt(contract_id, time) {
    const list = this.contracts.get(contract_id) ?? [];
    const at = Date.parse(time);
    const eligible = list
      .filter((c) => Date.parse(c.effective_from) <= at)
      .sort((a, b) => b.version - a.version);
    if (!eligible.length) throw new DomainError(`合同 ${contract_id} 在 ${time} 无生效版本`);
    return eligible[0];
  }
}
