import Plimit from "p-limit";

/**
 * 任务调度与中断注册表。
 *
 * 模块级、非 React：zustand store 只存可序列化状态，AbortController 这类活对象放这里。
 * 并发通过 p-limit 控制 —— 超出上限的任务在 limiter 队列里等待槽位。
 */

const controllers = new Map<string, AbortController>();

/**
 * 每个 taskId 的运行代数。cancel / resume / 重新 schedule 时递增，
 * 用来作废仍在 flight 的旧回调——否则旧 run 的 failTask/finishTask
 * 会把已经开始的新一轮又打回 cancelled/failed（表现为「一点重试就失败」）。
 */
const runGenerations = new Map<string, number>();

const DEFAULT_CONCURRENCY = 3;
let limit = Plimit(DEFAULT_CONCURRENCY);
let currentConcurrency = DEFAULT_CONCURRENCY;

/**
 * 调整并发上限。已在旧 limiter 队列中的任务继续按旧上限执行，
 * 新提交的任务使用新上限。
 */
export function setConcurrency(n: number) {
  const next = Math.max(1, Math.floor(n));
  if (next === currentConcurrency) return;
  currentConcurrency = next;
  limit = Plimit(next);
}

export function getConcurrency(): number {
  return currentConcurrency;
}

/** 开启新一轮运行，返回本轮 generation。旧轮的回调应在写状态前用 isCurrentGeneration 自检。 */
export function beginRun(taskId: string): number {
  const next = (runGenerations.get(taskId) ?? 0) + 1;
  runGenerations.set(taskId, next);
  return next;
}

export function isCurrentGeneration(taskId: string, generation: number): boolean {
  return runGenerations.get(taskId) === generation;
}

/** 作废当前 in-flight 回调（不登记新 run）。cancel 时用。 */
export function invalidateRun(taskId: string): void {
  runGenerations.set(taskId, (runGenerations.get(taskId) ?? 0) + 1);
}

/**
 * 排队执行一个任务。fn 收到该任务专属的 AbortSignal。
 *
 * 注意：AbortController 在调度前就登记，因此任务还在排队时也能被取消 ——
 * 此时 signal 已 aborted，fn 一开始就会中断。
 */
export function schedule<T>(
  taskId: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  controllers.set(taskId, controller);
  return limit(() => fn(controller.signal)).finally(() => {
    // 只清理自己登记的那个 —— 任务被取消后立刻续跑时，
    // Map 里已是新一轮的 controller，旧回调不能把它删掉，
    // 否则新一轮就再也取消不了了
    if (controllers.get(taskId) === controller) {
      controllers.delete(taskId);
    }
  });
}

export function cancel(taskId: string) {
  controllers.get(taskId)?.abort();
}

export function isActive(taskId: string): boolean {
  return controllers.has(taskId);
}

/** 任务彻底移除时清理 generation，避免 Map 无限增长 */
export function clearRun(taskId: string) {
  controllers.get(taskId)?.abort();
  controllers.delete(taskId);
  runGenerations.delete(taskId);
}

/** 判断错误是否由 abort 引起（用于把取消和真实失败区分开） */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error) {
    return err.name === "AbortError" || /abort/i.test(err.message);
  }
  return false;
}

/** 供引擎在长循环中调用的中断检查点 */
export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Task aborted", "AbortError");
  }
}
