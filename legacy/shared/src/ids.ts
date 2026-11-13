/** 生成带前缀的短 ID，例如 tsk_9f2c1a7b4e60。 */
export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Unix 毫秒时间戳。 */
export function now(): number {
  return Date.now();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
