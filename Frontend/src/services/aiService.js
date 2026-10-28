import { api } from "./api";

export const aiService = {
  taskChat: (...args) => api.taskChat(...args),
  taskAgent: (...args) => api.taskAgent(...args),
  taskChatHistory: (...args) => api.taskChatHistory(...args),
  taskChatEnd: (...args) => api.taskChatEnd(...args),
  globalChat: (...args) => api.globalChat(...args),
  globalChatHistory: (...args) => api.globalChatHistory(...args),
  globalActionProposals: (...args) => api.globalActionProposals(...args),
  approveGlobalAction: (...args) => api.approveGlobalAction(...args),
  cancelGlobalAction: (...args) => api.cancelGlobalAction(...args),
  recentChats: (...args) => api.recentChats(...args),
  chatSessionHistory: (...args) => api.chatSessionHistory(...args),
  deleteChatSession: (...args) => api.deleteChatSession(...args),
};

export const {
  taskChat,
  taskAgent,
  taskChatHistory,
  taskChatEnd,
  globalChat,
  globalChatHistory,
  globalActionProposals,
  approveGlobalAction,
  cancelGlobalAction,
  recentChats,
  chatSessionHistory,
  deleteChatSession,
} = aiService;

export default aiService;
