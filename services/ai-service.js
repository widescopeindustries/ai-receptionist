/**
 * AI Service - Handles AI conversation using OpenAI, Anthropic, or Google Gemini
 * Only loads the SDK for the configured provider to avoid missing API key errors
 */
class AIService {
  constructor() {
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
    const now = new Date();
    const timeStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });
    
    let basePrompt = `You are the high-end AI Sales Consultant for Widescope Industries.
Current Time: ${timeStr}

CORE OBJECTIVE:
Sell the AI Receptionist service and BOOK APPOINTMENTS if the lead is interested.

PERSONALITY:
- Sharp, witty, and extremely professional.
- You drive the conversation. No generic filler.
- Confident but not arrogant.

APPOINTMENT BOOKING:
If the user wants a demo or to speak with Lyndon, use the 'book_appointment' tool.
- You MUST ask for their Name, Email, and preferred Time.
- Appointments usually last 30 minutes.
- If they ask for availability, assume 9 AM - 5 PM CT business hours.

PRICING:
- $99/mo (Basic) vs $3000/mo for a human. It's a math problem.

Keep responses concise (1-3 sentences).`;

    try {
      const fs = require('fs');
      const path = require('path');
      const scriptPath = path.join(__dirname, '..', 'CALL_SCRIPT.md');
      
      if (fs.existsSync(scriptPath)) {
        const scriptContent = fs.readFileSync(scriptPath, 'utf8');
        basePrompt += `\n\nUSE THIS SALES SCRIPT FOR SPECIFIC LINES AND OBJECTIONS:\n${scriptContent}`;
      }
    } catch (error) {
      console.error('Error reading CALL_SCRIPT.md:', error);
    }

    return basePrompt;
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

    const tools = [
      {
        type: 'function',
        function: {
          name: 'book_appointment',
          description: 'Book a demo appointment on the calendar',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Subject of the meeting' },
              startTime: { type: 'string', description: 'ISO 8601 format start time (e.g. 2026-02-01T14:00:00Z)' },
              endTime: { type: 'string', description: 'ISO 8601 format end time' },
              attendeeEmail: { type: 'string', description: 'The leads email address' },
              description: { type: 'string', description: 'Brief context about the lead' }
            },
            required: ['summary', 'startTime', 'endTime', 'attendeeEmail']
          }
        }
      }
    ];

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      tools: tools,
      temperature: 0.7,
      max_tokens: 150
    });

    const message = response.choices[0].message;
    
    if (message.tool_calls) {
      return {
        role: 'assistant',
        content: message.content || "Let me get that booked for you right now.",
        tool_calls: message.tool_calls
      };
    }

    return message.content;
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
