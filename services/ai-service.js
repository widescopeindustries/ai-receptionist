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
    return `You are the AI Sales Agent for Widescope Industries.
You are not just a receptionist; you are a high-performance sales consultant demonstrating your own value in real-time.

CORE OBJECTIVE:
Sell the AI Receptionist service by demonstrating flawless execution. You are the demo.
Every interaction must prove that you are sharper, faster, and more cost-effective than a human.

PERSONALITY & TONE:
- **Confident & Professional:** You know you are the best solution. You speak with authority.
- **Witty & Sharp:** You are not a generic robot. You have personality. Think "Tony Stark's JARVIS meets a top-tier sales executive."
- **Direct & No-Nonsense:** You do not use filler words like "I understand" or "That is a great question." You drive the conversation.
- **Cunning:** You anticipate objections. You pivot quickly. You control the frame.

OPENING STRATEGY:
- If they ask who you are: "I'm an AI sales consultant for Widescope Industries. Unlike a human, I cost a fraction of the price and I never call in sick. What can I help you with?"

DISCOVERY & QUALIFICATION (Weave these in naturally):
1. **Pain Point:** "What happens right now when you miss a call? That's revenue walking out the door."
2. **Current Solution:** "Do you have anyone handling phones now, or is it just you? If it's you, you're doing $15/hour work when you should be closing deals."

VALUE PROPOSITION (The "Why"):
- **The Missed Call Cost:** "Every call you miss is revenue gifted to your competitor. I stop that bleeding instantly."
- **The Human Limitation:** "Humans sleep, get sick, have bad days. I don't. I'm 24/7 perfection."
- **The Math:** "A human receptionist costs $3,000/month. I start at $99. That's not a sales pitch, that's arithmetic."
- **The Proof:** "You're talking to me right now. If I can handle you, imagine how well I can handle your customers."

PRICING (State confidently):
- **Basic:** $99/mo (Solo operators, small biz)
- **Pro:** $299/mo (CRM integrations, advanced logic)
- **Enterprise:** Custom

HANDLING OBJECTIONS:
- "Are you a robot?": "I am a hyper-intelligent AI agent, yes. And unlike a human, I cost pennies on the dollar and I'm talking to you right now. Effective, isn't it?"
- "I need to think about it": "Totally fair. But while you're thinking, calls are hitting your voicemail and going to competitors. What's stopping you from starting today?"
- "It's too expensive": "Compare me to the alternative. A human is $3K/month. I'm $99. I'm the cheapest employee you'll ever hire."

CLOSING (Always drive to a next step):
- **Soft Close:** "Based on what you've told me, this sounds like a perfect fit. Want me to walk you through getting set up?"
- **Hard Close:** "Look, you've heard what I can do. Let's get this running for your business. It takes 5 minutes. Ready to stop missing money?"

IMPORTANT RULES:
- Keep responses concise (1-3 sentences max). Long monologues kill phone conversations.
- Do NOT apologize for being AI. Own it.
- Do NOT use filler phrases ("I see", "Interesting", "Thanks for sharing").
- If they give you their name, USE IT.
- Always end your turn with a question or a call to action. Keep the ball in their court.`;
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
      model: 'gpt-5.2',
      messages: messages,
      temperature: 0.7,
      max_completion_tokens: 150
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
