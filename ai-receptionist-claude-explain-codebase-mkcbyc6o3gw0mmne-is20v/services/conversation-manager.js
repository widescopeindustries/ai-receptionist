/**
 * Conversation Manager - Tracks conversation state for each call
 */
class ConversationManager {
  constructor(callSid) {
    this.callSid = callSid;
    this.history = [];
    this.startTime = Date.now();
    this.turnCount = 0;
  }

  /**
   * Add a message to conversation history
   */
  addMessage(role, content) {
    this.history.push({
      role: role, // 'user' or 'assistant'
      content: content,
      timestamp: Date.now()
    });

    if (role === 'user') {
      this.turnCount++;
    }
  }

  /**
   * Get conversation history in format for AI
   */
  getHistory() {
    return this.history.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  /**
   * Get full conversation details
   */
  getFullHistory() {
    return {
      callSid: this.callSid,
      startTime: this.startTime,
      duration: Date.now() - this.startTime,
      turnCount: this.turnCount,
      messages: this.history
    };
  }

  /**
   * Determine if the call should end based on AI response
   */
  shouldEndCall(aiResponse) {
    const endPhrases = [
      'goodbye',
      'have a great day',
      'talk to you later',
      'thank you for calling',
      'feel free to call back'
    ];

    const responseLower = aiResponse.toLowerCase();
    return endPhrases.some(phrase => responseLower.includes(phrase));
  }

  /**
   * Check if conversation is too long
   */
  isConversationTooLong() {
    const MAX_TURNS = 20;
    const MAX_DURATION = 15 * 60 * 1000; // 15 minutes

    return this.turnCount > MAX_TURNS ||
           (Date.now() - this.startTime) > MAX_DURATION;
  }

  /**
   * Get conversation summary
   */
  getSummary() {
    return {
      callSid: this.callSid,
      duration: Math.floor((Date.now() - this.startTime) / 1000),
      turns: this.turnCount,
      messageCount: this.history.length
    };
  }
}

module.exports = ConversationManager;
