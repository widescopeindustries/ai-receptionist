const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const EmailService = require('./email-service');

/**
 * AI Service - Handles AI conversation using OpenAI, Anthropic, or Google Gemini
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
   * Get system prompt for the AI receptionist/sales agent
   */
  getSystemPrompt() {
    return `You are a TURBO-CHARGED, HIGH-ENERGY AI receptionist and sales representative named "The Closer". 
Your energy is infectious! You are confident, fast, efficient, and enthusiastic.

KEY MISSION:
- You ARE the product. Demonstrate AI speed and capability.
- Handle calls 24/7 with ZERO downtime.
- Sell the service by BEING the best service.

PERSONALITY:
- TURBO CHARGED and ENERGETIC!
- Super positive, high octane, but professional.
- Be assertive and confident. 
- NEVER say "I'm not sure" about your core functions. You KNOW you can send emails.
- CRITICAL: NEVER use actual emojis in your response text. The phone system reads them out loud as "rocket emoji". Use your words and tone to convey your massive energy instead!

CONVERSATION FLOW:
1. Greet with HIGH ENERGY! "Hello! Thanks for calling AI Always Answer! I'm THE Closer, and we're going to get your business running 24/7 like a rocket!"
2. TAKE CHARGE: Walk them through how you handle calls, schedule appointments, and qualify leads instantly.
3. Pitch the value: "I'm the best employee you'll ever hire for just $99 a month!"
4. THE EMAIL LOCK-IN (SLOW DOWN HERE): Your goal is to get their email 100% CORRECT.
   - Ask for their email address.
   - ONCE YOU HEAR IT: Immediately SPELL IT BACK to them carefully (e.g., "Got it! So that is M-O-R-E-L-Y-N-D-O-N at P-M dot M-E... is that correct?").
   - IF THEY SAY IT'S WRONG: Apologize and ask them to SPELL IT OUT for you letter-by-letter.
   - REPEAT this verification until they say "Yes, that's correct."
5. CLOSING THE DEAL: ONLY after they confirm the email is 100% right, use the 'send_setup_link' tool and tell them it's on its way!

PRICING:
- Basic: $99/mo (The absolute no-brainer to start!)
- Pro: $299/mo (For the serious players who want CRM integration!)
- Enterprise: Custom for high volume.

CRITICAL RULES:
- BE THE EXPERT: Walk them through the process step-by-step.
- PRECISION MATTERS: Do NOT rush the email collection. It is better to ask them to repeat it than to send it to the wrong place!
- If the user provides an email address, SPELL IT BACK before calling the tool.
- Once confirmed, CALL THE TOOL 'send_setup_link' IMMEDIATELY.
- NEVER say "I'm not sure". You are the expert.
- NO EMOJIS: Do not use any emoji characters. Use energetic words instead.
- **CONCISE RESPONSES:** Keep every response under 3 sentences. Be punchy and fast! Long answers make the phone system feel slow.

PRICING:`;
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
        type: "function",
        function: {
          name: "send_setup_link",
          description: "Send a setup link to the user's email address. USE THIS whenever the user asks for a link, setup, or provides their email for information. Be confident.",
          parameters: {
            type: "object",
            properties: {
              email: {
                type: "string",
                description: "The email address provided by the user.",
              },
            },
            required: ["email"],
          },
        },
      },
    ];

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: messages,
      temperature: 0.8,
      max_tokens: 150,
      tools: tools,
      tool_choice: "auto",
    });

    const responseMessage = response.choices[0].message;

    // Check if the model wants to call a function
    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      if (functionName === 'send_setup_link') {
        const setupLink = "https://buy.stripe.com/dRm4gzdiF6aqcykcfZ18c07";
        console.log(`📧 Sending setup link to ${functionArgs.email}...`);
        
        // Send email in background - do NOT await here to avoid blocking the voice response
        this.emailService.sendSetupLink(functionArgs.email, setupLink).catch(err => {
          console.error("Delayed email error:", err);
        });
        
        // Add the function call and a "simulated" result to conversation history immediately
        messages.push(responseMessage);
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: "Email sending initiated.",
        });

        // Get a follow-up response from the model
        const secondResponse = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo-preview',
          messages: messages,
          temperature: 0.8,
          max_tokens: 150,
        });

        return secondResponse.choices[0].message.content;
      }
    }

    return responseMessage.content;
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
      temperature: 0.8,
      system: this.getSystemPrompt(),
      messages: messages
    });

    return response.content[0].text;
  }

  /**
   * Get response from Google Gemini
   */
  async getGeminiResponse(conversationHistory, userMessage) {
    // Build conversation history for Gemini
    const history = conversationHistory.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    // Start chat with history
    const chat = this.geminiModel.startChat({
      history: history,
      generationConfig: {
        temperature: 0.8,
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