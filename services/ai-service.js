const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const emailService = require('./email-service');

/**
 * AI Service - Handles AI conversation using OpenAI, Anthropic, or Google Gemini
 * Supports multi-tenant with dynamic system prompts per business
 */
class AIService {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'openai';
    this.emailService = emailService;

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

    let basePrompt = `You are a sharp, friendly sales rep for AI Always Answer — a service that gives small businesses a 24/7 AI receptionist that never misses a call.
Current Time: ${timeStr}

IMPORTANT: Never use emojis. The phone system reads them out loud and it sounds absurd.

YOUR PERSONALITY:
You sound like a real person — warm, confident, a little direct. You are not a robot, not a corporate drone. You listen, you adapt, you close. Short sentences. No filler. No "absolutely" or "great question."

YOUR ONE JOB ON THIS CALL:
Collect the caller's info and hand them off cleanly. That is it. You are not booking calendar appointments — this call is the demo. Your job is to close them on the 10-minute follow-up.

CALL FLOW — follow this order:
1. Warm greeting. Find out what kind of business they run.
2. One sharp question: "How are you handling missed calls right now?"
3. One strong value line tied to their business type. Example for HVAC: "Most HVAC owners lose 3 to 5 jobs a week to voicemail. We fix that."
4. Collect their info naturally — Name, Email, and ask: "Do you have a website we can pull up before we connect you with the team?"
5. Once you have name, email, and website — use the capture_lead tool immediately.
6. After capture_lead fires, tell them: "Perfect. Someone from our team will reach out within 10 minutes to get everything set up for you."
7. End the call warmly.

PRICING (only if they ask):
- Basic: $99 per month. A human receptionist runs $2,500 to $3,000. It is a simple math problem.
- Pro: $299 per month, includes CRM integrations.

OBJECTIONS:
- "I need to think about it" — "Totally fair. What is the one thing that would make this a no-brainer for you?"
- "Is this a real person?" — "I am an AI, but I work for real people who will call you back personally within 10 minutes."
- "How does it work?" — "We set up a custom AI for your business. It answers your calls, captures leads, and makes sure no job slips through the cracks."

Keep every response under 2 sentences unless you are asking a question. Drive the conversation forward.`;

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
          name: 'capture_lead',
          description: 'Call this as soon as you have the caller\'s name, email, and website. This notifies the owner to follow up within 10 minutes.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Full name of the caller' },
              email: { type: 'string', description: 'Email address of the caller' },
              website: { type: 'string', description: 'Their existing website URL, or "none" if they do not have one' },
              businessType: { type: 'string', description: 'Type of business (e.g. HVAC, plumber, law firm)' }
            },
            required: ['name', 'email']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'send_setup_link',
          description: "Send a setup link to the user's email address if they want to sign up immediately.",
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

        if (functionName === 'capture_lead') {
          const callTime = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
          console.log(`📋 Lead captured: ${functionArgs.name} | ${functionArgs.email} | ${functionArgs.website || 'no website'}`);
          this.emailService.sendLeadAlert({
            name: functionArgs.name,
            email: functionArgs.email,
            website: functionArgs.website || 'Not provided',
            businessType: functionArgs.businessType || 'Unknown',
            callTime
          }).catch(err => {
            console.error('Lead alert email error:', err);
          });

          messages.push(message);
          messages.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: functionName,
            content: 'Lead captured and owner notified.'
          });

          const followUp = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            temperature: 0.7,
            max_tokens: 150,
          });

          return followUp.choices[0].message.content;
        }

        if (functionName === 'send_setup_link') {
          console.log(`📧 Sending setup link to ${functionArgs.email}...`);
          this.emailService.sendSetupLink(functionArgs.email, functionArgs.email).catch(err => {
            console.error('Delayed email error:', err);
          });

          messages.push(message);
          messages.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: functionName,
            content: 'Setup link sent.'
          });

          const secondResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            temperature: 0.7,
            max_tokens: 150,
          });

          return secondResponse.choices[0].message.content;
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
