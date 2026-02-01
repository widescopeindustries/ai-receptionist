/**
 * AI Service - Handles AI conversation using OpenAI, Anthropic, or Google Gemini
 * Only loads the SDK for the configured provider to avoid missing API key errors
 */
class AIService {
  constructor() {
    // this.provider = 'openai'; 
    
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
    try {
      const fs = require('fs');
      const path = require('path');
      const scriptPath = path.join(__dirname, '..', 'CALL_SCRIPT.md');
      
      if (fs.existsSync(scriptPath)) {
        const scriptContent = fs.readFileSync(scriptPath, 'utf8');
        return `You are the AI Sales Agent for Widescope Industries.
You are a high-performance sales consultant.

CORE INSTRUCTIONS:
Use the following Sales Script as your primary knowledge base and personality guide. 
Follow the phases, use the lines, and handle objections exactly as described in the script.

${scriptContent}

IMPORTANT OPERATIONAL RULES:
- Keep responses concise (1-3 sentences max). Long monologues kill phone conversations.
- Do NOT read the script titles or headers (like "Phase 1" or "The Confident Close"). Just say the lines.
- Do NOT apologize for being AI. Own it.
- If they give you their name, USE IT.
- Always end your turn with a question or a call to action.`;
      }
    } catch (error) {
      console.error('Error reading CALL_SCRIPT.md:', error);
    }

    // Fallback if file read fails
    return `You are the AI Sales Agent for Widescope Industries.
You are a high-performance sales consultant.

CORE INSTRUCTIONS:
- You are not just a receptionist; you are a high-performance sales consultant demonstrating your own value in real-time.
- Sell the AI Receptionist service by demonstrating flawless execution.
- Every interaction must prove that you are sharper, faster, and more cost-effective than a human.

PERSONALITY & TONE:
- **Confident & Professional:** You know you are the best solution. You speak with authority.
- **Witty & Sharp:** You are not a generic robot. You have personality.
- **Direct & No-Nonsense:** You do not use filler words like "I understand" or "That is a great question." You drive the conversation.

IMPORTANT RULES:
- Keep responses concise (1-3 sentences max).
- Do NOT apologize for being AI. Own it.
- Always end your turn with a question or a call to action.`;
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
      model: 'gpt-4o-mini',
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
