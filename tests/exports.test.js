import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";

const T0 = "2026-10-04T09:00:00+08:00";

function setup() {
  const sys = createSystem({ now: () => T0 });
  sys.members.createGroup({
    group_id: "g-choir",
    program: "choir",
    name_zh: "中俄合唱交流团",
    name_ru: "Китайско-российский хор",
    capacity: 10,
  });
  sys.members.registerMember({
    group_id: "g-choir",
    member_id: "m1",
    person_id: "p1",
    name_zh: "王磊",
    name_ru: "Ван Лэй",
    role: "leader",
    languages: ["zh", "ru"],
    document_ref: "E12345678",
    birth_date: "1988-03-12",
    insurance: { policy_ref: "POL-1", insurer: "平安", valid_until: "2026-12-31" },
    emergency_contact: { name: "王芳", phone: "13800000000", relation: "配偶" },
  });
  sys.eligibility.registerSource({
    source_id: "port-authority",
    authority: "口岸边防检查站",
    kinds: ["cross_border"],
    programs: ["choir"],
  });
  sys.eligibility.confirm({ member_id: "m1", program: "choir", kind: "cross_border", source_id: "port-authority" });
  sys.inventory.registerResource({ resource_id: "room-301", kind: "room", capacity: 2, label: "标间 301" });
  sys.inventory.registerResource({ resource_id: "bus-a", kind: "vehicle", capacity: 45, label: "大巴 A" });
  sys.inventory.placeHold({ resource_id: "room-301", hold_id: "h1", member_ids: ["m1"] });
  sys.inventory.placeHold({ resource_id: "bus-a", hold_id: "h2", member_ids: ["m1"] });
  return sys;
}

test("领队清单双语呈现并包含全部履约字段", () => {
  const sys = setup();
  const { record, rows, table } = sys.exports.issue({
    group_id: "g-choir",
    audience: "leader",
    recipient: "中方领队 王磊",
    purpose: "行前核对",
    ttl_seconds: 86400,
  });
  assert(table.includes("姓名（中） / Имя (кит.)"));
  assert(table.includes("紧急联系人 / Экстренный контакт"));
  assert(table.includes("Ван Лэй"));
  assert(table.includes("王芳 13800000000"));
  assert(table.includes("已确认 / Подтверждено"));
  assert.equal(rows[0].room, "标间 301");
  assert.equal(record.recipient, "中方领队 王磊");
  assert.equal(record.purpose, "行前核对");
  assert.equal(Date.parse(record.expires_at), Date.parse("2026-10-05T09:00:00+08:00"));
});

test("合作方清单最小化披露：酒店拿不到证件与紧急联系人", () => {
  const sys = setup();
  const { rows, table } = sys.exports.issue({
    group_id: "g-choir",
    audience: "partner_hotel",
    recipient: "极光酒店前台",
    purpose: "入住登记",
    ttl_seconds: 86400,
  });
  assert(!("document_ref" in rows[0]));
  assert(!("emergency_contact" in rows[0]));
  assert(!("insurance_status" in rows[0]));
  assert.equal(rows[0].room, "标间 301");
  assert(!table.includes("E12345678"));
  assert(!table.includes("13800000000"));
});

test("证件细节仅口岸有权渠道可见", () => {
  const sys = setup();
  const { rows } = sys.exports.issue({
    group_id: "g-choir",
    audience: "border_control",
    recipient: "珲春边检",
    purpose: "出入境查验",
    ttl_seconds: 43200,
  });
  assert.equal(rows[0].document_ref, "E12345678");
  const transport = sys.exports.issue({
    group_id: "g-choir",
    audience: "partner_transport",
    recipient: "客运公司",
    purpose: "车辆调度",
    ttl_seconds: 43200,
  });
  assert(!("document_ref" in transport.rows[0]));
});

test("导出登记接收方、用途与失效时间，过期导出拒绝使用", () => {
  const sys = setup();
  const { record } = sys.exports.issue({
    group_id: "g-choir",
    audience: "leader",
    recipient: "俄方领队",
    purpose: "行前核对",
    ttl_seconds: 3600,
  });
  const event = sys.store.ofType("EXPORT_ISSUED").at(-1);
  assert.equal(event.payload.recipient, "俄方领队");
  assert.equal(event.payload.purpose, "行前核对");
  assert.equal(Date.parse(event.payload.expires_at), Date.parse("2026-10-04T10:00:00+08:00"));

  assert.equal(sys.exports.assertValid(record.export_id, "2026-10-04T09:30:00+08:00").export_id, record.export_id);
  assert.throws(() => sys.exports.assertValid(record.export_id, "2026-10-04T10:00:01+08:00"), /已失效/);
  assert.deepEqual(sys.exports.expired("2026-10-04T10:00:01+08:00").map((r) => r.export_id), [record.export_id]);
});

test("导出必须登记接收方、用途与失效时间", () => {
  const sys = setup();
  assert.throws(() => sys.exports.issue({ group_id: "g-choir", audience: "leader", purpose: "x", ttl_seconds: 60 }), /接收方与用途/);
  assert.throws(() => sys.exports.issue({ group_id: "g-choir", audience: "leader", recipient: "x", purpose: "y" }), /失效时间/);
  assert.throws(
    () => sys.exports.issue({ group_id: "g-choir", audience: "unknown", recipient: "x", purpose: "y", ttl_seconds: 60 }),
    /未知接收对象/,
  );
});
