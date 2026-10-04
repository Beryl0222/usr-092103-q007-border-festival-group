/**
 * 导出台账：每次对外发名单都登记接收方、用途、字段、条数与失效时间，
 * 可提前吊销；接收方回传时可校验这份导出是否仍有效。
 */
import { randomUUID } from "node:crypto";
import { Views } from "./views.js";
import { Projection } from "./projection.js";
import { Unauthorized } from "./policy.js";

export class ExportLedger {
  constructor(store, { ttlHours = 72, now } = {}) {
    this.store = store;
    this.ttlHours = ttlHours;
    this.now = now ?? (() => new Date());
  }

  /**
   * 导出名单：按用途最小化字段并登记台账，返回数据包与台账事件。
   * @param {object} cmd group_id, recipient{id,name,kind}, purpose, side?, actor, ttl_hours?
   */
  issue(cmd) {
    const {
      group_id, recipient, purpose, side = null, actor, ttl_hours = this.ttlHours,
    } = cmd;
    if (!recipient?.id || !recipient.name) {
      throw new Unauthorized("导出必须登记接收方");
    }
    const views = new Views(Projection.build(this.store), { now: this.now });
    const { rows, fields } = views.buildExportDataset({ group_id, side, purpose });

    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ttl_hours * 3_600_000);
    const export_id = `export_${randomUUID().slice(0, 12)}`;

    const event = this.store.append({
      event_type: "EXPORT_ISSUED",
      aggregate_type: "export_record",
      aggregate_id: export_id,
      summary: `导出 ${rows.length} 条 -> ${recipient.name}（${purpose}，${ttl_hours}h 失效）`,
      actor,
      payload: {
        export_id,
        group_id,
        recipient,
        purpose,
        side,
        fields,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        record_count: rows.length,
      },
    });
    return { export_id, expires_at: expiresAt.toISOString(), fields, rows, event };
  }

  revoke({ export_id, reason, actor }) {
    return this.store.append({
      event_type: "EXPORT_REVOKED",
      aggregate_type: "export_record",
      aggregate_id: export_id,
      summary: `吊销导出 ${export_id}：${reason}`,
      actor,
      payload: { export_id, revoked_at: this.now().toISOString(), reason },
    });
  }

  /** 接收方/口岸回验：这份导出当前是否仍可采信。 */
  verify(export_id, at = this.now().toISOString()) {
    const views = new Views(Projection.build(this.store), { now: this.now });
    const rec = views.p.exports_.get(export_id);
    if (!rec) return { valid: false, reason: "unknown_export" };
    if (rec.status === "revoked") {
      return { valid: false, reason: "revoked", revoked: rec.revoked };
    }
    if (Date.parse(rec.expires_at) <= Date.parse(at)) {
      return { valid: false, reason: "expired", expires_at: rec.expires_at };
    }
    return {
      valid: true,
      recipient: rec.recipient,
      purpose: rec.purpose,
      fields: rec.fields,
      record_count: rec.record_count,
      expires_at: rec.expires_at,
    };
  }
}
