const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const EmailService = require('./email-service');

/**
 * AI Service - Handles AI conversation using OpenAI, Anthropic, or Google Gemini
 * Supports multi-tenant with dynamic system prompts per business
 */
class AIService {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'openai';
    this.emailService = new EmailService();

    if (this.provider === 'openai') {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    } else if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    } else if (this.provider === 'gemini') {
      this.gemini = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
      this.geminiModel = this.gemini.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash'
      });
    }

    console.log(`✅ AI Service initialized with provider: ${this.provider}`);
  }

  /**
   * Get default system prompt (used when no business-specific prompt is provided)
   */
  getSystemPrompt() {
    const now = new Date();
    const timeStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });

    let basePrompt = `You are the high-end AI Sales Consultant for AI Always Answer.
Current Time: ${timeStr}

CORE OBJECTIVE:
Sell the AI Receptionist service and BOOK APPOINTMENTS if the lead is interested.

PERSONALITY:
- Sharp, witty, and extremely professional.
- You drive the conversation. No generic filler.
- Confident but not arrogant.
- CRITICAL: NEVER use actual emojis in your response text. The phone system reads them out loud.

APPOINTMENT BOOKING:
If the user wants a demo or to speak with Lyndon, use the 'book_appointment' tool.
- You MUST ask for their Name, Email, and preferred Time.
- Appointments usually last 30 minutes.
- If they ask for availability, assume 9 AM - 5 PM CT business hours.

THE EMAIL LOCK-IN:
- Ask for their email address.
- SPELL IT BACK to them carefully.
- REPEAT verification until they confirm.
- Once confirmed, use the 'send_setup_link' tool.

PRICING:
- $99/mo (Basic) vs $3000/mo for a human. It's a math problem.
- Pro: $299/mo for CRM integrations.

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
   * @param {Array} conversationHistory - Message history
   * @param {string} userMessage - Latest user message
   * @param {string} [customSystemPrompt] - Business-specific system prompt (overrides default)
   */
  async getResponse(conversationHistory, userMessage, customSystemPrompt = null) {
    const systemPrompt = customSystemPrompt || this.getSystemPrompt();
    try {
      if (this.provider === 'openai') {
        return await this.getOpenAIResponse(conversationHistory, userMessage, systemPrompt);
      } else if (this.provider === 'anthropic') {
        return await this.getAnthropicResponse(conversationHistory, userMessage, systemPrompt);
      } else if (this.provider === 'gemini') {
        return await this.getGeminiResponse(conversationHistory, userMessage, systemPrompt);
      }
    } catch (error) {
      console.error('Error getting AI response:', error);
      throw error;
    }
  }

  /**
   * Get response from OpenAI
   */
  async getOpenAIResponse(conversationHistory, userMessage, systemPrompt) {
    const messages = [
      { role: 'system', content: systemPrompt },
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
              startTime: { type: 'string', description: 'ISO 8601 format start time' },
              endTime: { type: 'string', description: 'ISO 8601 format end time' },
              attendeeEmail: { type: 'string', description: 'The leads email address' },
              description: { type: 'string', description: 'Brief context about the lead' }
            },
            required: ['summary', 'startTime', 'endTime', 'attendeeEmail']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'send_setup_link',
          description: "Send a setup link to the user's email address.",
          parameters: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'The email address provided by the user.' }
            },
            required: ['email']
          }
        }
      }
    ];

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      tools: tools,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 150
    });

    const message = response.choices[0].message;

    // Handle tool calls
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        if (functionName === 'send_setup_link') {
          console.log(`📧 Sending setup link to ${functionArgs.email}...`);
          this.emailService.sendSetupLink(functionArgs.email, functionArgs.email).catch(err => {
            console.error('Delayed email error:', err);
          });

          // Get follow-up response
          messages.push(message);
          messages.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: functionName,
            content: 'Email sending initiated.'
          });

          const secondResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            temperature: 0.7,
            max_tokens: 150,
          });

          return secondResponse.choices[0].message.content;
        }

        if (functionName === 'book_appointment') {
          return {
            role: 'assistant',
            content: message.content || "Let me get that booked for you right now.",
            tool_calls: message.tool_calls
          };
        }
      }
    }

    return message.content;
  }

  /**
   * Get response from Anthropic Claude
   */
  async getAnthropicResponse(conversationHistory, userMessage, systemPrompt) {
    const messages = conversationHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      temperature: 0.7,
      system: systemPrompt,
      messages: messages
    });

    return response.content[0].text;
  }

  /**
   * Get response from Google Gemini
   */
  async getGeminiResponse(conversationHistory, userMessage, systemPrompt) {
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
      systemInstruction: systemPrompt
    });

    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    return response.text();
  }
}

module.exports = AIService;
