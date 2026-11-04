import { DurableObject } from "cloudflare:workers";
import { reserve, settle, stats, utcDay } from "./budget-core.js";

// Single global instance ("global"): serialises all counter updates atomically.
export class Budget extends DurableObject {
  async reserve(args) {
    await this.#gc(args.nowMs);
    return reserve(this.ctx.storage, args);
  }
  async settle(args) { return settle(this.ctx.storage, args); }
  async stats(nowMs = Date.now()) { return stats(this.ctx.storage, nowMs); }
  async #gc(nowMs) {
    const day = utcDay(nowMs), minute = Math.floor(nowMs / 60000);
    const last = await this.ctx.storage.get("gc");
    if (last === minute) return;
    await this.ctx.storage.put("gc", minute);
    const old = [];
    for (const k of (await this.ctx.storage.list({ prefix: "ipm:" })).keys()) if (Number(k.split(":")[1]) < minute) old.push(k);
    for (const p of ["ipd:", "g:"]) for (const k of (await this.ctx.storage.list({ prefix: p })).keys()) if (k.split(":")[1] < utcDay(nowMs - 7 * 864e5)) old.push(k);
    for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
  }
}
