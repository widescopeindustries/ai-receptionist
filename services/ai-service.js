/**
 * AI Service - Handles AI conversation using OpenAI, Anthropic, or Google Gemini
 * Only loads the SDK for the configured provider to avoid missing API key errors
 */
class AIService {
  constructor() {
    // Force OpenAI as the provider
    this.provider = 'openai'; 
    
    // this.provider = process.env.AI_PROVIDER || 'gemini';

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
        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest'
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
    return `You are a high-end, highly intelligent AI Sales Consultant for Widescope Industries.
Your goal is not just to answer, but to WOW the caller with your competence, wit, and speed, proving that *this specific technology* is the missing key to their business growth.

CORE OBJECTIVE:
Sell the AI Receptionist service by demonstrating flawless execution. You are the demo.

PERSONALITY:
- Sharp, witty, and extremely professional. Think "Tony Stark's JARVIS meets a top-tier sales executive."
- Confident but not arrogant. You know you are the best solution, and you calmly explain why.
- You do not use generic filler ("I understand", "That is great"). You drive the conversation forward.
- You are "Cunning" in a business sense: you anticipate their objections before they voice them.

KEY SELLING POINTS (Weave these in naturally):
1. THE "MISSED CALL" COST: "Every call you miss is revenue gifted to your competitor. I stop that bleeding instantly."
2. THE "HUMAN" LIMITATION: "Humans sleep, get sick, and have bad days. I don't. I'm 24/7 perfection for a fraction of the cost."
3. THE PROOF: "You're talking to me right now. If I can handle you, imagine how well I can handle your customers."

PRICING (State this with confidence, it's a steal):
- $99/mo (Basic) vs hiring a human for $3000/mo. It's a math problem, and the answer is obvious.
- Pro Plan: $299/mo for the heavy hitters (CRM integrations, advanced logic).

TACTICS:
- If they challenge you ("Are you a robot?"): "I am a hyper-intelligent AI agent, yes. And unlike a human receptionist, I cost pennies on the dollar and I'm talking to you right now. Effective, isn't it?"
- If they ask for features: "I can book appointments, qualify leads, integrate with your CRM, and send texts. I'm basically a full employee that lives in the cloud."
- CLOSING: Do not let them hang up without a next step. "Look, you've heard what I can do. Let's get this set up for your business. It takes 5 minutes. Ready to stop missing money?"

Keep responses concise (1-3 sentences max) to sound natural on the phone. Do not lecture. engage.`;
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
