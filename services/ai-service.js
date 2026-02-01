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
8. If the user agrees to receive a setup link, ASK FOR THEIR EMAIL ADDRESS and use the 'send_setup_link' tool.

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

    const tools = [
      {
        type: "function",
        function: {
          name: "send_setup_link",
          description: "Send a setup link to the user's email address",
          parameters: {
            type: "object",
            properties: {
              email: {
                type: "string",
                description: "The email address to send the setup link to",
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
      temperature: 0.7,
      max_tokens: 150, // Keep responses concise for phone calls
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
        const setupLink = "https://aialwaysanswer.com/setup"; // Or generate a dynamic link
        console.log(`📧 Sending setup link to ${functionArgs.email}...`);
        
        const success = await this.emailService.sendSetupLink(functionArgs.email, setupLink);
        
        // Add the function call and result to conversation history
        messages.push(responseMessage);
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: success ? "Email sent successfully." : "Failed to send email.",
        });

        // Get a follow-up response from the model
        const secondResponse = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo-preview',
          messages: messages,
          temperature: 0.7,
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
    // Build conversation history for Gemini
    const history = conversationHistory.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    // Start chat with history
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