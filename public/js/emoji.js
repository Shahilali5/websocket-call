/**
 * Telegram-Style Animated Emojis & Interactive Reaction Module
 */

export const TELEGRAM_EMOJIS = [
  '❤️', '🔥', '👍', '😂', '🎉', '👏', '😍', '🚀', '💯', '✨',
  '😎', '🤯', '🥳', '😭', '🥺', '🤩', '💡', '⚡', '🙏', '🤝',
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '☺️', '😊', '😇',
  '😉', '😌', '🥰', '😘', '😋', '😜', '🤪', '🤫', '🤔', '🤐',
  '👋', '✌️', '🤟', '🤘', '👌', '🤌', '💪', '👀', '💋', '🎯'
];

/**
 * Checks if a string consists exclusively of 1 to 3 emojis
 */
export function isOnlyEmojis(str) {
  if (!str) return false;
  const trimmed = str.trim();
  // Regex matching emojis and emoji sequences
  const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier_Base}|\uFE0F|\u200D){1,3}$/u;
  return emojiRegex.test(trimmed);
}

/**
 * Generates Telegram-style reaction selector HTML
 */
export function getReactionBarHtml(msgId) {
  const quickReactions = ['❤️', '🔥', '👍', '😂', '🎉', '👏'];
  return `
    <div class="msg-reaction-bar d-flex gap-1 p-1 bg-white rounded-pill shadow-sm border" data-msg-id="${msgId}">
      ${quickReactions.map(r => `<button class="btn btn-sm p-1 rounded-circle reaction-pill-btn" data-reaction="${r}">${r}</button>`).join('')}
    </div>
  `;
}
