import { create } from "zustand";

interface GlobalStore {
  openSetting: boolean;
  openHistory: boolean;
  openKnowledge: boolean;
  /** 新任务默认使用的思考模式（表单状态）。运行中任务的模式记录在各自的 ThinkTask 上 */
  thinkMode: ThinkMode;
}

interface GlobalActions {
  setOpenSetting: (visible: boolean) => void;
  setOpenHistory: (visible: boolean) => void;
  setOpenKnowledge: (visible: boolean) => void;
  setThinkMode: (mode: ThinkMode) => void;
}

export const useGlobalStore = create<GlobalStore & GlobalActions>((set) => ({
  openSetting: false,
  openHistory: false,
  openKnowledge: false,
  thinkMode: "deep-think",
  setOpenSetting: (visible) => set({ openSetting: visible }),
  setOpenHistory: (visible) => set({ openHistory: visible }),
  setOpenKnowledge: (visible) => set({ openKnowledge: visible }),
  setThinkMode: (mode) => set({ thinkMode: mode }),
}));
