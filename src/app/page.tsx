"use client";
import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import { useGlobalStore } from "@/store/global";
import { useSettingStore } from "@/store/setting";
import { useActiveTask, hasPendingTasks } from "@/store/thinkTask";
import { setConcurrency } from "@/utils/deep-think/registry";

const Header = dynamic(() => import("@/components/Internal/Header"));
const Setting = dynamic(() => import("@/components/Setting"));
const Topic = dynamic(() => import("@/components/Research/Topic"));
const History = dynamic(() => import("@/components/History"));
const Knowledge = dynamic(() => import("@/components/Knowledge"));
const TaskBar = dynamic(() => import("@/components/DeepThink/TaskBar"));
const ThinkingProcess = dynamic(
  () => import("@/components/DeepThink/ThinkingProcess")
);
const AgentProgress = dynamic(
  () => import("@/components/DeepThink/AgentProgress")
);
const DeepThinkResults = dynamic(
  () =>
    import("@/components/DeepThink/Results").then((mod) => ({
      default: mod.DeepThinkResults,
    }))
);
const UltraThinkResults = dynamic(
  () =>
    import("@/components/DeepThink/Results").then((mod) => ({
      default: mod.UltraThinkResults,
    }))
);

function Home() {
  const { t } = useTranslation();
  const {
    openSetting,
    setOpenSetting,
    openHistory,
    setOpenHistory,
    openKnowledge,
    setOpenKnowledge,
  } = useGlobalStore();

  const task = useActiveTask();
  const isThinking = task?.status === "running";

  const { theme, maxConcurrentTasks } = useSettingStore();
  const { setTheme } = useTheme();

  useLayoutEffect(() => {
    const settingStore = useSettingStore.getState();
    setTheme(settingStore.theme);
  }, [theme, setTheme]);

  // 并发上限跟随设置
  useEffect(() => {
    setConcurrency(maxConcurrentTasks);
  }, [maxConcurrentTasks]);

  // 任务跑在浏览器里，刷新即丢失 —— 有未完成任务时拦一下
  useEffect(() => {
    const handler = (ev: BeforeUnloadEvent) => {
      if (hasPendingTasks()) ev.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  return (
    <div className="max-lg:max-w-screen-md max-w-screen-lg mx-auto px-4">
      <Header />
      <TaskBar />
      <main>
        <Topic />

        {/* Deep Think Mode - Show thinking process (only when actually thinking) */}
        {task?.mode === "deep-think" && isThinking && !task.deepThinkResult && (
          <>
            <section className="p-4 border rounded-md mt-4">
              <ThinkingProcess
                steps={[
                  {
                    id: "thinking",
                    label: t("deepThink.status.thinking", {
                      iteration: task.currentIteration,
                      phase: task.currentPhase || "initializing",
                    }),
                    status: "running",
                    detail: task.currentIteration > 0 ? `第 ${task.currentIteration} 轮 - ${task.currentPhase}` : undefined,
                  },
                ]}
              />
            </section>
            {/* Show current solution if available */}
            {task.currentSolution && (
              <section className="p-4 border rounded-md mt-4">
                <h3 className="font-semibold text-lg mb-3">
                  {t("deepThink.results.currentSolution")} (第 {task.currentIteration} 轮)
                </h3>
                <div className="prose dark:prose-invert max-w-none text-sm">
                  <pre className="whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 p-3 rounded">
                    {task.currentSolution}
                  </pre>
                </div>
              </section>
            )}
          </>
        )}

        {/* Ultra Think Mode - Show agent progress (only when actually thinking) */}
        {task?.mode === "ultra-think" && isThinking && !task.ultraThinkResult && (
          <section className="p-4 border rounded-md mt-4">
            <AgentProgress agents={task.agentResults} />
          </section>
        )}

        {/* Results Display */}
        {task?.mode === "deep-think" && task.deepThinkResult && (
          <section className="p-4 border rounded-md mt-4">
            <DeepThinkResults result={task.deepThinkResult} />
          </section>
        )}
        {task?.mode === "ultra-think" && task.ultraThinkResult && (
          <section className="p-4 border rounded-md mt-4">
            <UltraThinkResults result={task.ultraThinkResult} />
          </section>
        )}
      </main>
      <footer className="my-4 text-center text-sm text-gray-600 print:hidden">
        <a href="https://github.com/u14app/" target="_blank">
          {t("copyright", {
            name: "U14App",
          })}
        </a>
      </footer>
      <aside className="print:hidden">
        <Setting open={openSetting} onClose={() => setOpenSetting(false)} />
        <History open={openHistory} onClose={() => setOpenHistory(false)} />
        <Knowledge
          open={openKnowledge}
          onClose={() => setOpenKnowledge(false)}
        />
      </aside>
    </div>
  );
}

export default Home;
