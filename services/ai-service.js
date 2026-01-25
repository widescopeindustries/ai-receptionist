/**
 * AI Service - Handles AI conversation using OpenAI, Anthropic, or Google Gemini
 * Only loads the SDK for the configured provider to avoid missing API key errors
 */
class AIService {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'gemini';

    // Only initialize the selected provider
    if (this.provider === 'openai') {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai');
      }
      const OpenAI = require('openai');
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    } else if (this.provider === 'anthropic') {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
      }
      const Anthropic = require('@anthropic-ai/sdk');
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    } else if (this.provider === 'gemini') {
      if (!process.env.GOOGLE_API_KEY) {
        throw new Error('GOOGLE_API_KEY is required when AI_PROVIDER=gemini');
      }
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      this.gemini = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
      this.geminiModel = this.gemini.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash'
      });
    } else {
      throw new Error(`Unknown AI_PROVIDER: ${this.provider}. Use 'openai', 'anthropic', or 'gemini'`);
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
      } else if (this.provider === 'gemini') {
        return await this.getGeminiResponse(conversationHistory, userMessage);
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
      max_tokens: 150
    });

    return response.choices[0].message.content;
  }

  /**
   * Get response from Anthropic Claude
   */
  async getAnthropicResponse(conversationHistory, userMessage) {
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

  /**
   * Get response from Google Gemini
   */
  async getGeminiResponse(conversationHistory, userMessage) {
    const history = conversationHistory.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const chat = this.geminiModel.startChat({
      history: history,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 150,
      },
      systemInstruction: this.getSystemPrompt()
    });

    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    return response.text();
  }
}

module.exports = AIService;
