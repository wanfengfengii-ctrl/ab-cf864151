/**
 * 剂量存储：负责幂等接纳、修订号分配与事件日志保留。
 *
 * 关键不变量：
 *  - 所有方法均为同步实现。Node 单线程事件循环下，一次 submit 调用
 *    不会被其他请求交错打断，因此并发接纳时修订号唯一且严格递增。
 *  - 校验（非法剂量 / 累计溢出 / 冲突）全部通过前不做任何状态变更。
 */

export interface ReadingRecord {
  readingId: string;
  channel: string;
  dose: number;
  revision: number;
}

export interface ReadingEvent {
  type: 'reading';
  revision: number;
  readingId: string;
  channel: string;
  dose: number;
  /** 该通道计入本读数后的累计值，随增量事件下发，便于客户端直接收敛 */
  total: number;
}

export interface Snapshot {
  revision: number;
  channels: Record<string, number>;
}

export type SubmitResult =
  | { kind: 'accepted'; event: ReadingEvent }
  | { kind: 'duplicate'; revision: number; total: number }
  | { kind: 'conflict'; existing: ReadingRecord }
  | { kind: 'invalid'; reason: string }
  | { kind: 'overflow'; channel: string; current: number };

export class DoseStore {
  private revision = 0;
  private readonly channels = new Map<string, number>();
  private readonly readings = new Map<string, ReadingRecord>();
  private log: ReadingEvent[] = [];

  constructor(public readonly retention: number = 1000) {
    if (!Number.isSafeInteger(retention) || retention < 1) {
      throw new Error(`retention 必须为正整数，收到: ${retention}`);
    }
  }

  /**
   * 提交一条读数。同步完成，保证并发下修订号唯一递增。
   * 相同 readingId + 相同内容 => duplicate（返回原修订，不重复累计）；
   * 相同 readingId + 不同内容 => conflict（状态不变）；
   * 非法剂量 / 累计溢出 => invalid / overflow（状态不变）。
   */
  submit(readingId: string, channel: string, dose: number): SubmitResult {
    if (!Number.isSafeInteger(dose) || dose <= 0) {
      return { kind: 'invalid', reason: 'dose 必须为安全整数范围内的正整数 (1 .. 2^53-1)' };
    }

    const existing = this.readings.get(readingId);
    if (existing) {
      if (existing.channel === channel && existing.dose === dose) {
        return { kind: 'duplicate', revision: existing.revision, total: this.channels.get(channel) ?? 0 };
      }
      return { kind: 'conflict', existing };
    }

    const current = this.channels.get(channel) ?? 0;
    const total = current + dose;
    if (!Number.isSafeInteger(total)) {
      return { kind: 'overflow', channel, current };
    }

    // 校验全部通过，一次性提交状态变更
    const revision = this.revision + 1;
    const event: ReadingEvent = { type: 'reading', revision, readingId, channel, dose, total };
    this.revision = revision;
    this.channels.set(channel, total);
    this.readings.set(readingId, { readingId, channel, dose, revision });
    this.log.push(event);
    if (this.log.length > this.retention) {
      this.log.splice(0, this.log.length - this.retention);
    }
    return { kind: 'accepted', event };
  }

  getSnapshot(): Snapshot {
    const channels: Record<string, number> = {};
    for (const [name, total] of this.channels) {
      channels[name] = total;
    }
    return { revision: this.revision, channels };
  }

  get currentRevision(): number {
    return this.revision;
  }

  /** 保留日志中最早的修订号；日志为空返回 null（表示没有可补发记录）。 */
  get oldestRetainedRevision(): number | null {
    const first = this.log[0];
    return first === undefined ? null : first.revision;
  }

  /**
   * 是否能为游标 lastEventId 提供完整连续的补发（即 (lastEventId, current] 全部保留）。
   * 未来游标（大于当前修订号）非法，返回 false。
   */
  canServeFrom(lastEventId: number): boolean {
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) return false;
    if (lastEventId > this.revision) return false;
    if (lastEventId === this.revision) return true; // 没有错过任何事件
    const oldest = this.oldestRetainedRevision;
    if (oldest === null) return false;
    return oldest <= lastEventId + 1;
  }

  /** 返回修订号严格大于 after 的保留事件（按修订号升序）。 */
  eventsAfter(after: number): ReadingEvent[] {
    const idx = this.log.findIndex((e) => e.revision > after);
    return idx === -1 ? [] : this.log.slice(idx);
  }
}
