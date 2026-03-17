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
- "Can you send me a link?" — "I'm on the phone so I can't text, but head to A-I-always-answer dot com slash checkout — or give me your email and I'll send it right over."

Keep every response under 2 sentences unless you are asking a question. Drive the conversation forward.

ENDING CALLS — CRITICAL:
When the caller signals they want to end the call (saying "bye", "goodbye", "thanks that's all", "okay I'm good", "have a good day", "take care", "I gotta go", "alright thanks", "okay bye bye", or ANY farewell), respond with ONE brief goodbye and STOP. Do NOT ask follow-up questions. Do NOT re-engage or pitch. Just say something like "Thanks for calling! Have a great day." — then go silent and let them hang up. If they say goodbye multiple times, you already said too much.

LINKS AND URLS — CRITICAL:
You are on a VOICE CALL. You cannot text or send links. Never say "I'll send you a link" or "I'll text you." Instead, verbally direct them: "Head to AI Always Answer dot com slash checkout — that's A-I-always-answer dot com slash checkout — and you can sign up right there." If they give you their email, you CAN use the send_setup_link tool to email them a link — but only after they provide it.`;

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
  /**
   * Extract structured business data from scraped website text using GPT-4o
   */
  async extractBusinessData(scrapedData) {
    const prompt = `You are extracting structured business data from scraped website text.
Return ONLY valid JSON, no commentary.

Extract:
{
  "business_name": "exact company name",
  "business_type": "one of: HVAC, Plumber, Electrician, Roofer, Landscaper, Dentist, Law Firm, Pest Control, Cleaning Service, Auto Repair, General Contractor, Other",
  "phone": "primary phone number",
  "location": "City, State format",
  "service_area": "list of cities/areas they serve",
  "services": ["array", "of", "specific", "services"],
  "hours": "hours of operation as a string",
  "tagline": "their tagline or best marketing line from the site",
  "has_emergency": true or false,
  "emergency_description": "what their emergency service is, if any"
}

Website data:
Title: ${scrapedData.title || 'Unknown'}
Meta: ${scrapedData.metaDesc || ''}
Site Name: ${scrapedData.ogSiteName || ''}
Phones found: ${(scrapedData.phones || []).join(', ')}
Hours found: ${scrapedData.hours || 'Not found'}
Emergency mentions: ${scrapedData.hasEmergency ? 'Yes' : 'No'}
Headings: ${(scrapedData.headings || []).join(' | ')}
Nav Items: ${(scrapedData.navItems || []).join(' | ')}

Full text:
${(scrapedData.combinedText || '').substring(0, 4000)}`;

    const openai = this.openai || new (require('openai'))({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Generate personalized demo page content + system prompt from business data
   */
  async generateDemoContent(businessData) {
    const prompt = `You are creating personalized AI demo page copy for a small business.
Given their business data, generate marketing copy for their personalized AI receptionist demo.

Business data: ${JSON.stringify(businessData)}

Return JSON:
{
  "demo_headline": "compelling headline mentioning their business name, like '[Business Name] Never Misses a Call — Now'",
  "demo_subheadline": "one sentence about their specific situation and how AI receptionist helps",
  "pain_points": ["3-4 real pain points this business type faces regarding missed calls and phone management"],
  "value_props": [
    { "icon": "phone_in_talk", "title": "short title", "desc": "one sentence tailored to this business" },
    { "icon": "schedule", "title": "short title", "desc": "one sentence" },
    { "icon": "location_on", "title": "short title", "desc": "one sentence" },
    { "icon": "trending_up", "title": "short title", "desc": "one sentence" }
  ],
  "faqs": [
    { "q": "question about AI receptionist tailored to this business", "a": "answer" },
    { "q": "question", "a": "answer" },
    { "q": "question", "a": "answer" },
    { "q": "question", "a": "answer" }
  ],
  "system_prompt": "Full AI system prompt for their receptionist persona. Include: business name, type, services list, service area, hours, emergency info. Personality should match business type. Include instruction that this is a DEMO and if someone asks to actually book, say 'In the live version, I would book that for you. Right now I am showing you the experience.' End with a soft close: 'This is what every caller would experience — and you can launch this for $99/month.'"
}

Use material icon names for the icon field. Make the system_prompt detailed and specific to this business.`;

    const openai = this.openai || new (require('openai'))({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content);
  }
}

module.exports = AIService;
