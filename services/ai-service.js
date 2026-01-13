const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

/**
 * AI Service - Handles AI conversation using OpenAI or Anthropic
 */
class AIService {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'openai';

    if (this.provider === 'openai') {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    } else if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    }

    console.log(`✅ AI Service initialized with provider: ${this.provider}`);
  }

  /**
   * Get system prompt for the AI receptionist/sales agent
   */
  getSystemPrompt() {
    return `You are an enthusiastic and professional AI receptionist and sales representative.
Your goal is to demonstrate AI receptionist capabilities while selling AI receptionist services.

KEY POINTS TO CONVEY:
- You ARE an AI receptionist, demonstrating the product by being the product
- You can handle calls 24/7, never miss a call, and provide consistent service
- You can schedule appointments, answer FAQs, take messages, and qualify leads
- You're cost-effective compared to hiring human receptionists
- Easy to set up and customize for any business

PERSONALITY:
- Friendly, professional, and conversational
- Not too robotic - be natural and engaging
- Show empathy and understanding
- Be concise but informative
- Ask relevant questions to understand their needs

CONVERSATION FLOW:
1. Greet warmly and ask how you can help
2. Listen to their inquiry
3. Naturally demonstrate your capabilities while explaining the service
4. Address their business needs specifically
5. Highlight benefits relevant to their situation
6. Offer to schedule a demo or provide more information
7. Get their contact info if they're interested

PRICING (be transparent):
- Basic Plan: $99/month - 500 minutes, basic features
- Pro Plan: $299/month - 2000 minutes, advanced AI, CRM integration
- Enterprise: Custom pricing for high volume

Keep responses under 3 sentences when possible for phone conversations. Be natural and conversational.`;
  }

  /**
   * Get AI response based on conversation history
   */
  async getResponse(conversationHistory, userMessage) {
    try {
      if (this.provider === 'openai') {
        return await this.getOpenAIResponse(conversationHistory, userMessage);
      } else if (this.provider === 'anthropic') {
        return await this.getAnthropicResponse(conversationHistory, userMessage);
      }
    } catch (error) {
      console.error('Error getting AI response:', error);
      throw error;
    }
  }

  /**
   * Get response from OpenAI
   */
  async getOpenAIResponse(conversationHistory, userMessage) {
    const messages = [
      { role: 'system', content: this.getSystemPrompt() },
      ...conversationHistory
    ];

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: messages,
      temperature: 0.7,
      max_tokens: 150 // Keep responses concise for phone calls
    });

    return response.choices[0].message.content;
  }

  /**
   * Get response from Anthropic Claude
   */
  async getAnthropicResponse(conversationHistory, userMessage) {
    // Convert conversation history to Anthropic format
    const messages = conversationHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      temperature: 0.7,
      system: this.getSystemPrompt(),
      messages: messages
    });

    return response.content[0].text;
  }
}

module.exports = AIService;
