"use client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  CircleSlash,
  Clock,
  Loader2,
  MessageCircleQuestion,
  Plus,
  RotateCw,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useThinkTaskStore } from "@/store/thinkTask";
import useDeepThinkEngine from "@/hooks/useDeepThink";

function StatusIcon({ status }: { status: ThinkTaskStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />;
    case "queued":
      return <Clock className="w-4 h-4 text-gray-400 shrink-0" />;
    case "waiting":
      return (
        <MessageCircleQuestion className="w-4 h-4 text-purple-500 shrink-0" />
      );
    case "completed":
      return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
    case "cancelled":
    default:
      return <CircleSlash className="w-4 h-4 text-gray-400 shrink-0" />;
  }
}

function statusChipColor(status: ThinkTaskStatus, active: boolean) {
  if (active) return "border-primary bg-primary/5 shadow-sm";
  switch (status) {
    case "running":
      return "border-blue-300 bg-blue-50 dark:bg-blue-900/10";
    case "waiting":
      return "border-purple-300 bg-purple-50 dark:bg-purple-900/10";
    case "completed":
      return "border-green-300 bg-green-50 dark:bg-green-900/10";
    case "failed":
      return "border-red-300 bg-red-50 dark:bg-red-900/10";
    case "queued":
    case "cancelled":
    default:
      return "border-gray-200 dark:border-gray-700";
  }
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** 运行中任务的计时。用 1s 定时器而非 requestAnimationFrame —— 多任务并行时后者开销过大 */
function Elapsed({ task }: { task: ThinkTask }) {
  const live = task.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (!task.startedAt) return null;
  const end = live ? now : task.finishedAt ?? task.startedAt;
  return (
    <small className="font-mono text-xs opacity-70 shrink-0">
      {formatElapsed(end - task.startedAt)}
    </small>
  );
}

/** 提示用户续跑会复用什么，而不是笼统的「重试」 */
function resumeTooltip(
  t: (key: string, opts?: Record<string, unknown>) => string,
  task: ThinkTask
): string {
  const snap = task.snapshot;
  if (task.mode === "ultra-think") {
    const done = snap?.completedAgents?.length ?? 0;
    if (done > 0) return t("deepThink.task.resumeAgents", { count: done });
  } else if (snap?.completedIterations) {
    return t("deepThink.task.resumeIteration", {
      iteration: snap.completedIterations,
    });
  }
  return t("deepThink.task.retry");
}

function TaskBar() {
  const { t } = useTranslation();
  const tasks = useThinkTaskStore((state) => state.tasks);
  const activeTaskId = useThinkTaskStore((state) => state.activeTaskId);
  const setActive = useThinkTaskStore((state) => state.setActive);
  const { cancelTask, removeTask, resumeTask } = useDeepThinkEngine();

  const running = tasks.filter(
    (task) =>
      task.status === "running" ||
      task.status === "queued" ||
      task.status === "waiting"
  ).length;

  // 只有一个任务且没有后台活动时隐藏整条，保持单任务体验与改造前一致
  if (tasks.length <= 1 && running === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 mb-2 print:hidden">
      {tasks.map((task) => {
        const active = task.id === activeTaskId;
        const finished =
          task.status === "completed" ||
          task.status === "failed" ||
          task.status === "cancelled";
        // 只有中断的任务能续跑；已完成的没必要
        const resumable =
          task.status === "failed" || task.status === "cancelled";
        const resumeHint = resumeTooltip(t, task);

        return (
          <div
            key={task.id}
            onClick={() => setActive(task.id)}
            title={task.error ? `${task.question}\n\n${task.error}` : task.question}
            className={cn(
              "group flex items-center gap-2 max-w-[16rem] px-3 py-1.5 border rounded-md",
              "text-sm cursor-pointer transition-all hover:shadow-sm",
              statusChipColor(task.status, active)
            )}
          >
            <StatusIcon status={task.status} />
            <span className="truncate flex-1 min-w-0">{task.question}</span>
            <Elapsed task={task} />
            {resumable && (
              <button
                type="button"
                title={resumeHint}
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 hover:text-blue-500"
                onClick={(ev) => {
                  ev.stopPropagation();
                  resumeTask(task.id);
                }}
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              title={finished ? t("deepThink.task.remove") : t("deepThink.task.cancel")}
              className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 hover:text-red-500"
              onClick={(ev) => {
                ev.stopPropagation();
                if (finished) {
                  removeTask(task.id);
                } else {
                  cancelTask(task.id);
                }
              }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => setActive("")}
        className={cn(
          "flex items-center gap-1 px-3 py-1.5 border rounded-md text-sm",
          "transition-all hover:shadow-sm hover:bg-slate-100 dark:hover:bg-slate-800",
          activeTaskId === "" && "border-primary bg-primary/5"
        )}
      >
        <Plus className="w-4 h-4" />
        <span>{t("deepThink.task.newTask")}</span>
      </button>
    </div>
  );
}

export default TaskBar;
