/**
 * ChatContext - Centralized state management for TUI
 * Provides performant, debounced state updates for smooth UX
 */

import React, { createContext, useContext, useReducer, useCallback, useMemo, ReactNode } from "react";

// ============================================================================
// Types
// ============================================================================

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  timestamp?: number;
  id: string;
}

export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  startTime?: number;
  endTime?: number;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
}

export interface WorkflowStage {
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  timestamp?: number;
}

export interface Tokens {
  used: number;
  limit?: number;
  prompt: number;
  completion: number;
}

export interface Cost {
  current: number;
  limit?: number;
  formatted: {
    prompt: string;
    completion: string;
    total: string;
  };
}

export interface ChatState {
  // Messages
  messages: Message[];
  streamingMessage: string | null;
  
  // Input
  inputValue: string;
  inputHistory: string[];
  historyIndex: number;
  
  // Status
  isThinking: boolean;
  statusMessage: string | null;
  
  // Tools
  activeTools: ToolCall[];
  toolHistory: ToolCall[];
  
  // Workflow
  workflowStages: WorkflowStage[];
  currentIteration: number;
  maxIterations: number;
  
  // Metrics
  tokens: Tokens;
  cost: Cost;
  messageCount: number;
  sessionUptime: number;
  
  // UI State
  mode: 'edit' | 'plan';
  slashSuggestions: SlashCommandSuggestion[];
  selectedSuggestion: number;
  
  // Scroll
  scrollOffset: number;
  scrollAnchor: 'end' | 'manual';
  maxScrollOffset: number;
}

export interface SlashCommandSuggestion {
  command: string;
  description: string;
  badges: string[];
}

// ============================================================================
// Actions
// ============================================================================

type ChatAction =
  | { type: 'ADD_MESSAGE'; payload: Message }
  | { type: 'START_STREAMING' }
  | { type: 'APPEND_CHUNK'; payload: string }
  | { type: 'FINISH_STREAMING'; payload: { fullContent: string } }
  | { type: 'SET_INPUT_VALUE'; payload: string }
  | { type: 'SET_THINKING'; payload: boolean }
  | { type: 'SET_STATUS'; payload: string | null }
  | { type: 'ADD_TOOL'; payload: ToolCall }
  | { type: 'UPDATE_TOOL'; payload: { id: string; updates: Partial<ToolCall> } }
  | { type: 'ADD_WORKFLOW_STAGE'; payload: WorkflowStage }
  | { type: 'UPDATE_WORKFLOW_STAGE'; payload: { name: string; status: WorkflowStage['status'] } }
  | { type: 'SET_ITERATION'; payload: { current: number; max: number } }
  | { type: 'UPDATE_TOKENS'; payload: Partial<Tokens> }
  | { type: 'UPDATE_COST'; payload: Partial<Cost> }
  | { type: 'SET_MODE'; payload: 'edit' | 'plan' }
  | { type: 'SET_SLASH_SUGGESTIONS'; payload: SlashCommandSuggestion[] }
  | { type: 'SET_SELECTED_SUGGESTION'; payload: number }
  | { type: 'SET_SCROLL_OFFSET'; payload: number }
  | { type: 'SET_SCROLL_ANCHOR'; payload: 'end' | 'manual' }
  | { type: 'ADD_TO_HISTORY'; payload: string }
  | { type: 'NAVIGATE_HISTORY'; payload: 'up' | 'down' }
  | { type: 'CLEAR_SLASH_SUGGESTIONS' }
  | { type: 'CLEAR_MESSAGES' };

// ============================================================================
// Reducer
// ============================================================================

const initialState: ChatState = {
  messages: [],
  streamingMessage: null,
  inputValue: '',
  inputHistory: [],
  historyIndex: -1,
  isThinking: false,
  statusMessage: null,
  activeTools: [],
  toolHistory: [],
  workflowStages: [],
  currentIteration: 0,
  maxIterations: 10,
  tokens: { used: 0, prompt: 0, completion: 0 },
  cost: { current: 0, formatted: { prompt: '$0.00', completion: '$0.00', total: '$0.00' } },
  messageCount: 0,
  sessionUptime: Date.now(),
  mode: 'edit',
  slashSuggestions: [],
  selectedSuggestion: 0,
  scrollOffset: 0,
  scrollAnchor: 'end',
  maxScrollOffset: 0,
};

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'ADD_MESSAGE': {
      return {
        ...state,
        messages: [...state.messages, action.payload],
        messageCount: state.messageCount + 1,
      };
    }

    case 'START_STREAMING': {
      return {
        ...state,
        isThinking: true,
        streamingMessage: '',
      };
    }

    case 'APPEND_CHUNK': {
      return {
        ...state,
        streamingMessage: (state.streamingMessage || '') + action.payload,
      };
    }

    case 'FINISH_STREAMING': {
      const assistantMessage: Message = {
        role: 'assistant',
        content: action.payload.fullContent,
        timestamp: Date.now(),
        id: `msg-${Date.now()}-${Math.random()}`,
      };
      return {
        ...state,
        messages: [...state.messages, assistantMessage],
        streamingMessage: null,
        isThinking: false,
        messageCount: state.messageCount + 1,
        scrollAnchor: 'end',
      };
    }

    case 'SET_INPUT_VALUE':
      return {
        ...state,
        inputValue: action.payload,
      };

    case 'SET_THINKING':
      return {
        ...state,
        isThinking: action.payload,
      };

    case 'SET_STATUS':
      return {
        ...state,
        statusMessage: action.payload,
      };

    case 'ADD_TOOL': {
      return {
        ...state,
        activeTools: [...state.activeTools, action.payload],
        toolHistory: [...state.toolHistory, action.payload],
      };
    }

    case 'UPDATE_TOOL': {
      return {
        ...state,
        activeTools: state.activeTools.map(tool =>
          tool.id === action.payload.id
            ? { ...tool, ...action.payload.updates }
            : tool
        ),
        toolHistory: state.toolHistory.map(tool =>
          tool.id === action.payload.id
            ? { ...tool, ...action.payload.updates }
            : tool
        ),
      };
    }

    case 'ADD_WORKFLOW_STAGE': {
      return {
        ...state,
        workflowStages: [...state.workflowStages, action.payload],
      };
    }

    case 'UPDATE_WORKFLOW_STAGE': {
      return {
        ...state,
        workflowStages: state.workflowStages.map(stage =>
          stage.name === action.payload.name
            ? { ...stage, status: action.payload.status }
            : stage
        ),
      };
    }

    case 'SET_ITERATION':
      return {
        ...state,
        currentIteration: action.payload.current,
        maxIterations: action.payload.max,
      };

    case 'UPDATE_TOKENS':
      return {
        ...state,
        tokens: { ...state.tokens, ...action.payload },
      };

    case 'UPDATE_COST':
      return {
        ...state,
        cost: { ...state.cost, ...action.payload },
      };

    case 'SET_MODE':
      return {
        ...state,
        mode: action.payload,
      };

    case 'SET_SLASH_SUGGESTIONS':
      return {
        ...state,
        slashSuggestions: action.payload,
        selectedSuggestion: 0,
      };

    case 'SET_SELECTED_SUGGESTION':
      return {
        ...state,
        selectedSuggestion: action.payload,
      };

    case 'SET_SCROLL_OFFSET':
      return {
        ...state,
        scrollOffset: Math.max(0, Math.min(action.payload, state.maxScrollOffset)),
      };

    case 'SET_SCROLL_ANCHOR':
      return {
        ...state,
        scrollAnchor: action.payload,
      };

    case 'ADD_TO_HISTORY': {
      const newHistory = [action.payload, ...state.inputHistory].slice(0, 500);
      return {
        ...state,
        inputHistory: newHistory,
        historyIndex: -1,
      };
    }

    case 'NAVIGATE_HISTORY': {
      const newIndex = action.payload === 'up'
        ? Math.min(state.historyIndex + 1, state.inputHistory.length - 1)
        : Math.max(state.historyIndex - 1, -1);
      return {
        ...state,
        historyIndex: newIndex,
        inputValue: newIndex >= 0 ? state.inputHistory[newIndex] : state.inputValue,
      };
    }

    case 'CLEAR_SLASH_SUGGESTIONS':
      return {
        ...state,
        slashSuggestions: [],
        selectedSuggestion: 0,
      };

    case 'CLEAR_MESSAGES':
      return {
        ...state,
        messages: [],
        messageCount: 0,
        scrollOffset: 0,
      };

    default:
      return state;
  }
}

// ============================================================================
// Context
// ============================================================================

interface ChatContextValue {
  state: ChatState;
  dispatch: React.Dispatch<ChatAction>;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChatContext must be used within ChatProvider');
  }
  return context;
}

// ============================================================================
// Convenience Hooks
// ============================================================================

export function useChatState() {
  const { state } = useChatContext();
  return state;
}

export function useChatDispatch() {
  const { dispatch } = useChatContext();
  return dispatch;
}

export function useMessages() {
  const { state } = useChatContext();
  return state.messages;
}

export function useInput() {
  const { state, dispatch } = useChatContext();
  
  const setInputValue = useCallback((value: string) => {
    dispatch({ type: 'SET_INPUT_VALUE', payload: value });
  }, [dispatch]);

  const addToHistory = useCallback((value: string) => {
    dispatch({ type: 'ADD_TO_HISTORY', payload: value });
  }, [dispatch]);

  const navigateHistory = useCallback((direction: 'up' | 'down') => {
    dispatch({ type: 'NAVIGATE_HISTORY', payload: direction });
  }, [dispatch]);

  return {
    value: state.inputValue,
    history: state.inputHistory,
    historyIndex: state.historyIndex,
    setInputValue,
    addToHistory,
    navigateHistory,
  };
}

export function useStreaming() {
  const { state, dispatch } = useChatContext();

  const startStreaming = useCallback(() => {
    dispatch({ type: 'START_STREAMING' });
  }, [dispatch]);

  const appendChunk = useCallback((chunk: string) => {
    dispatch({ type: 'APPEND_CHUNK', payload: chunk });
  }, [dispatch]);

  const finishStreaming = useCallback((fullContent: string) => {
    dispatch({ type: 'FINISH_STREAMING', payload: { fullContent } });
  }, [dispatch]);

  return {
    isStreaming: state.streamingMessage !== null || state.isThinking,
    streamingContent: state.streamingMessage,
    startStreaming,
    appendChunk,
    finishStreaming,
  };
}

export function useTools() {
  const { state, dispatch } = useChatContext();

  const addTool = useCallback((tool: ToolCall) => {
    dispatch({ type: 'ADD_TOOL', payload: tool });
  }, [dispatch]);

  const updateTool = useCallback((id: string, updates: Partial<ToolCall>) => {
    dispatch({ type: 'UPDATE_TOOL', payload: { id, updates } });
  }, [dispatch]);

  return {
    activeTools: state.activeTools,
    toolHistory: state.toolHistory,
    addTool,
    updateTool,
  };
}

export function useWorkflow() {
  const { state, dispatch } = useChatContext();

  const addStage = useCallback((stage: WorkflowStage) => {
    dispatch({ type: 'ADD_WORKFLOW_STAGE', payload: stage });
  }, [dispatch]);

  const updateStage = useCallback((name: string, status: WorkflowStage['status']) => {
    dispatch({ type: 'UPDATE_WORKFLOW_STAGE', payload: { name, status } });
  }, [dispatch]);

  const setIteration = useCallback((current: number, max: number) => {
    dispatch({ type: 'SET_ITERATION', payload: { current, max } });
  }, [dispatch]);

  return {
    stages: state.workflowStages,
    currentIteration: state.currentIteration,
    maxIterations: state.maxIterations,
    addStage,
    updateStage,
    setIteration,
  };
}

export function useMetrics() {
  const { state, dispatch } = useChatContext();

  const updateTokens = useCallback((tokens: Partial<Tokens>) => {
    dispatch({ type: 'UPDATE_TOKENS', payload: tokens });
  }, [dispatch]);

  const updateCost = useCallback((cost: Partial<Cost>) => {
    dispatch({ type: 'UPDATE_COST', payload: cost });
  }, [dispatch]);

  return {
    tokens: state.tokens,
    cost: state.cost,
    messageCount: state.messageCount,
    sessionUptime: state.sessionUptime,
    updateTokens,
    updateCost,
  };
}

export function useScroll() {
  const { state, dispatch } = useChatContext();

  const setOffset = useCallback((offset: number) => {
    dispatch({ type: 'SET_SCROLL_OFFSET', payload: offset });
  }, [dispatch]);

  const setAnchor = useCallback((anchor: 'end' | 'manual') => {
    dispatch({ type: 'SET_SCROLL_ANCHOR', payload: anchor });
  }, [dispatch]);

  return {
    offset: state.scrollOffset,
    anchor: state.scrollAnchor,
    maxOffset: state.maxScrollOffset,
    setOffset,
    setAnchor,
  };
}

export function useSlashCommands() {
  const { state, dispatch } = useChatContext();

  const setSuggestions = useCallback((suggestions: SlashCommandSuggestion[]) => {
    dispatch({ type: 'SET_SLASH_SUGGESTIONS', payload: suggestions });
  }, [dispatch]);

  const setSelected = useCallback((index: number) => {
    dispatch({ type: 'SET_SELECTED_SUGGESTION', payload: index });
  }, [dispatch]);

  const clearSuggestions = useCallback(() => {
    dispatch({ type: 'CLEAR_SLASH_SUGGESTIONS' });
  }, [dispatch]);

  return {
    suggestions: state.slashSuggestions,
    selected: state.selectedSuggestion,
    setSuggestions,
    setSelected,
    clearSuggestions,
  };
}
