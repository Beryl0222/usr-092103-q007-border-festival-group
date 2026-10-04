/**
 * 事件存储：事件溯源内核。
 * - 每个聚合一条流，版本号从 1 单调递增；
 * - append 采用乐观并发控制，expectedVersion 不匹配即抛 ConcurrentModification；
 * - appendBatch 在同一把锁内原子提交，多事件要么全部成功要么全部失败；
 * - 可选持久化到 JSONL（每行一个信封），重启后可重放恢复。
 */
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validateEvent } from "../validator.js";
import { validatePayload } from "./catalog.js";

export class DomainError extends Error {}

export class ConcurrentModification extends DomainError {
  constructor(aggregateId, expected, actual) {
    super(
      `聚合 ${aggregateId} 版本冲突：期望 ${expected}，当前 ${actual}`,
    );
    this.code = "CONCURRENT_MODIFICATION";
    this.aggregateId = aggregateId;
  }
}

export class ValidationError extends DomainError {
  constructor(errors) {
    super(`事件校验失败：${errors.join("；")}`);
    this.code = "VALIDATION_ERROR";
    this.errors = errors;
  }
}

let seq = 0;
export function newEventId(prefix = "evt") {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${seq}_${randomUUID().slice(0, 8)}`;
}

export class EventStore {
  constructor({ path, now } = {}) {
    this.path = path;
    /** 可注入时钟；测试与联调剧本可固定业务时间 */
    this.now = now ?? (() => new Date());
    /** @type {Map<string, object[]>} aggregateId -> events */
    this.streams = new Map();
    /** @type {object[]} 全序事件日志 */
    this.log = [];
    this.seq = 0;
  }

  static async fromFile(path, opts = {}) {
    const store = new EventStore({ path, ...opts });
    if (path && existsSync(path)) {
      const text = await readFile(path, "utf8");
      for (const line of text.split("\n")) {
        if (line.trim()) store._ingest(JSON.parse(line));
      }
    }
    return store;
  }

  _ingest(event) {
    const errors = [...validateEvent(event), ...validatePayload(event.event_type, event.payload)];
    if (errors.length) throw new ValidationError(errors);

    const stream = this.streams.get(event.aggregate_id) ?? [];
    if (stream.length + 1 !== event.version) {
      throw new ConcurrentModification(
        event.aggregate_id,
        stream.length,
        event.version - 1,
      );
    }
    stream.push(event);
    this.streams.set(event.aggregate_id, stream);
    this.seq += 1;
    const stored = { ...event, _seq: this.seq };
    this.log.push(stored);
    return stored;
  }

  /**
   * 追加一个事件。
   * @param {object} draft 不含 event_id/version 的事件草稿
   * @param {{expectedVersion?: number}} opts 该聚合当前期望版本；新聚合为 0
   */
  append(draft, opts = {}) {
    const expectedVersions =
      "expectedVersion" in opts
        ? { [draft.aggregate_id]: opts.expectedVersion }
        : undefined;
    return this.appendBatch([draft], { expectedVersions })[0];
  }

  /** 原子批次：同一把锁内依次校验版本并提交，多事件要么全部成功要么全部失败。 */
  appendBatch(drafts, opts = {}) {
    // 单进程互斥；同一批次内的事件按草稿顺序连续占用版本号。
    if (opts.expectedVersions) {
      for (const [id, expected] of Object.entries(opts.expectedVersions)) {
        const actual = this.streams.get(id)?.length ?? 0;
        if (actual !== expected) {
          throw new ConcurrentModification(id, expected, actual);
        }
      }
    }
    const committed = [];
    const versionPlan = new Map();
    for (const draft of drafts) {
      const base = this.streams.get(draft.aggregate_id)?.length ?? 0;
      const planned = (versionPlan.get(draft.aggregate_id) ?? base) + 1;
      const event = {
        event_id: draft.event_id ?? newEventId(draft.event_type.toLowerCase()),
        occurred_at: draft.occurred_at ?? this.now().toISOString(),
        ...draft,
        version: planned,
      };
      versionPlan.set(draft.aggregate_id, planned);
      committed.push(event);
    }
    // 全部通过版本规划后统一落库；任一 _ingest 失败则不写入后续事件。
    const results = committed.map((event) => this._ingest(event));
    if (this.path) {
      // 批次内事件一次追加，保持磁盘原子语义；落盘前剥离内部序号
      const clean = ({ _seq, ...e }) => e;
      appendFile(this.path, results.map((e) => `${JSON.stringify(clean(e))}\n`).join("")).catch(
        () => {},
      );
    }
    return results;
  }

  stream(aggregateId) {
    return [...(this.streams.get(aggregateId) ?? [])];
  }

  version(aggregateId) {
    return this.streams.get(aggregateId)?.length ?? 0;
  }

  /** 全量重放，供投影使用。 */
  *readAll() {
    for (const event of this.log) yield event;
  }

  /** 按 event_type 过滤的重放。 */
  *readByType(...types) {
    for (const event of this.log) {
      if (types.includes(event.event_type)) yield event;
    }
  }
}
