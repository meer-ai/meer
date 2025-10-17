/**
 * Modern Ink-based TUI exports
 */

export { MeerChat, renderMeerChat } from './MeerChat.js';
export { InkChatAdapter } from './InkChatAdapter.js';
export type { InkChatConfig } from './InkChatAdapter.js';

// Export mode type for external use
export type Mode = 'edit' | 'plan';
