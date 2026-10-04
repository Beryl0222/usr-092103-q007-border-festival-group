# 领域事件目录

所有跨模块交换均使用 `contracts/domain.schema.json` 的公共信封：
`event_id / event_type / aggregate_type / aggregate_id / occurred_at / version / summary`，
可附 `payload / source / actor / correlation_id / causation_id / metadata`。

- **版本语义**：`version` 是聚合流上的单调正整数，从 1 开始。提交方携带期望版本做乐观并发控制（OCC/CAS）；同一业务过程的多个事件用 `correlation_id` 关联。
- **来源语义**：`source.kind` 标明事件来源系统。跨境资格只接受 `port_authority` / `consular_authority`，旅行社、合作方来源会被命令层拒绝。
- **最小化**：证件号码从不进入事件载荷，只保留 `document_ref` 句柄；保险单号、电话、紧急联系人仅在成员聚合内保存，按导出用途放行（见“字段最小化”）。

## 聚合与事件

### travel_group 团组
| 事件 | 含义 | payload 关键字段 |
| --- | --- | --- |
| GROUP_CREATED | 建团（合唱/体育/贸易） | group_id, activity_kind, name |
| GROUP_UPDATED | 团组信息变更 | group_id, changes |
| LEADER_ASSIGNED | 中/俄方领队到位 | group_id, side(domestic/foreign), leader_id |
| TEAM_DEFINED | 团队关系树（声部/采购组可嵌套） | group_id, team_id, team_name, parent_team_id |
| CROSSING_BATCH_PROPOSED / accepted | 限流分批方案（proposed→accepted，旧方案置 superseded） | plan_id, status, batches[]{slot_id,team_id,member_ids,batch_no} |
| CROSSING_RESCHEDULED | 整段改约留痕，不删除行程 | from_slot_id, to_slot_id, reason |

### member_profile 成员
| 事件 | 含义 |
| --- | --- |
| MEMBER_REGISTERED | 成员登记（side 标明中/俄方；领队只能登记本方）。可含 languages/needs_interpreter/dietary/phone/emergency_contact/insurance |
| MEMBER_PROFILE_UPDATED | 资料变更；aliases 追加合并 |
| MEMBER_WITHDRAWN | 退出，记录 reason/at，并联动释放名下占位（过程保留） |
| NAME_DISAMBIGUATED | 同名消歧：member_ids + 每人 resolution 说明 |

### member_eligibility 跨境资格（仅有权来源）
| 事件 | 来源要求 |
| --- | --- |
| ELIGIBILITY_REQUESTED | 任意（发起申请），authority: port_entry/consulate |
| ELIGIBILITY_CONFIRMED | port_entry 仅接受 source.kind=port_authority；consulate 仅接受 consular_authority |
| ELIGIBILITY_DENIED | 同上；只记录 reason_code，不记录证件细节 |

### resource / 占位（车辆、房间、席位）
占位是 **resource 聚合流内的实体**，全部生命周期事件落在资源流上，以资源版本串行化，从根本上避免并发超售。

| 事件 | 含义 |
| --- | --- |
| RESOURCE_DEFINED | resource_id, kind(vehicle/hotel_room/event_seat), capacity |
| RESOURCE_HELD | 容量足够：state=held，记录 resource_version |
| WAITLIST_JOINED | 容量不足：自动候补，rank 为候补序号 |
| WAITLIST_PROMOTED | 释放后按 rank 顺序自动转正（原子批次） |
| HOLD_RELEASED | 释放（成员退出联动释放时 reason=member_withdrawn:*） |

### booking 多人共用预订（旅行社订房/订车）
BOOKING_CREATED（capacity/contract_ref）→ BOOKING_MEMBER_ATTACHED（多人挂接，超容量拒绝）→ BOOKING_MEMBER_DETACHED / BOOKING_CANCELLED。挂接与移除全部留痕。

### crossing_slot 口岸分时
CROSSING_SLOT_DEFINED（port_code/direction/start_at/capacity）、CROSSING_CAPACITY_CHANGED（限流留痕 old→new）、CROSSING_ASSIGNED（方案确认后按批次占用）。

### contract / attendance_proof 合同与结算
- CONTRACT_AGREED：同一合同多版本，terms 含 unit_price、cancel_tiers(before_hours/fee_pct)、no_show_pct。
- CANCELLATION_LIABILITY_DECIDED：按“变更时点”选取当时已生效的最新合同版本，再套用阶梯；输出 contract_version/fee_pct/rule。
- ATTENDANCE_RECORDED：仅 port_authority/festival_dispatch 可记录实际到访（入境章/现场核验 proof_ref）。
- ATTENDANCE_SETTLED：basis=actual_attendance，金额 = 实际到访人数 × 合同单价；未到访不计费。

### export_record / audit_log 导出台账
EXPORT_ISSUED（recipient、purpose、fields、issued_at、expires_at、record_count）、EXPORT_REVOKED。接收方可 `verify()` 回验有效/过期/吊销。

## 字段最小化（导出用途 → 字段组）

| 用途 purpose | 可见字段组 |
| --- | --- |
| hotel_checkin | identity, team, logistics |
| transport | identity, team, logistics |
| seat_manifest | identity, team, needs, eligibility, logistics |
| border_manifest | identity, team, eligibility, document_ref, logistics |
| insurance_verification | identity, insurance, contact |
| leader_roster / dispatch | 全字段（领队仅本方成员） |

字段组：identity（编号/姓名/别名/方别）、needs（语言/翻译/餐饮/无障碍）、eligibility（资格状态）、document_ref（资格句柄）、logistics（预订/占位/口岸批次）、contact（电话/紧急联系人）、insurance（保险）。**证件号码在任何用途下都不外发。**
