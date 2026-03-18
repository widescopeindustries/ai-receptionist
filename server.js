require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const AIService = require('./services/ai-service');
const ConversationManager = require('./services/conversation-manager');
const db = require('./services/database');
const stripeService = require('./services/stripe-service');
const emailService = require('./services/email-service');
const calendarService = require('./services/google-calendar');
const { getBusinessByNumber, getBusinessById } = require('./config/businesses');
const elevenLabs = require('./services/elevenlabs-service');
const openaiTTS = require('./services/openai-tts-service');
const realtimeService = require('./services/openai-realtime-service');
const { scrapeSite } = require('./services/scraper');
const outbound = require('./services/outbound');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Explicit SEO routes
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// Middleware
// CORS — allow mission control and other dashboards to hit API endpoints
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  // Allow mission control, localhost, and aialwaysanswer.com
  if (origin.includes('missiom-control') || origin.includes('vercel.app') || origin.includes('localhost') || origin.includes('aialwaysanswer')) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * Status endpoint - simple text health check
 */
app.get('/status', (req, res) => {
  res.send('AI Always Answer is active and ready to close! 🚀');
});

/**
 * Utility to strip emojis from text so they aren't read out loud by TTS
 */
function cleanTextForTTS(text) {
  if (!text) return "";
  return text.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '');
}

// Raw body for Stripe webhooks (must come before urlencoded)
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: false }));

// Cookie parser (simple, no dependency needed)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.trim().split('=');
      req.cookies[name.trim()] = decodeURIComponent(rest.join('='));
    });
  }
  next();
});

// Store active conversations
const conversations = new Map();

/**
 * ElevenLabs TTS endpoint — Twilio plays this URL instead of using twiml.say()
 * Usage: /voice/tts?text=Hello+there
 */
app.get('/voice/tts', (req, res) => {
  const text = req.query.text || 'Hello';
  if (process.env.VOICE_ENGINE === 'openai-realtime') {
    console.log(`🎙️  OpenAI TTS (shimmer): "${text.substring(0, 60)}..."`);
    openaiTTS.streamTTS(text, res);
  } else {
    console.log(`🎙️  ElevenLabs TTS: "${text.substring(0, 60)}..."`);
    elevenLabs.streamTTS(text, res);
  }
});

/**
 * Helper: build a twiml.play() URL for ElevenLabs TTS
 * Falls back to twiml.say() if ElevenLabs is not configured
 */
function speakText(twiml, text, fallbackVoice) {
  const cleaned = cleanTextForTTS(text);
  const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
  if (process.env.VOICE_ENGINE === 'openai-realtime') {
    // OpenAI TTS (shimmer) — matches the Realtime voice
    const encoded = encodeURIComponent(cleaned);
    twiml.play(`${baseUrl}/voice/tts?text=${encoded}`);
  } else if (process.env.ELEVENLABS_API_KEY) {
    const encoded = encodeURIComponent(cleaned);
    twiml.play(`${baseUrl}/voice/tts?text=${encoded}`);
  } else {
    twiml.say({ voice: fallbackVoice || 'Polly.Danielle-Neural', language: 'en-US' }, cleaned);
  }
}

// Initialize AI Service
const aiService = new AIService();

// ==================== TWILIO VOICE ENDPOINTS ====================

/**
 * Main webhook endpoint - Twilio calls this when someone dials your number
 * When VOICE_ENGINE=openai-realtime, redirects to the full-duplex realtime endpoint.
 */
app.post('/voice/incoming', async (req, res) => {
  const phoneFrom = req.body.From;
  const callSid = req.body.CallSid;

  // Log lead + check for outbound callback regardless of routing
  try {
    const normalizedFrom = phoneFrom?.replace(/[^\d+]/g, '');
    const outboundMatch = db.db.prepare(
      'SELECT id, business_name FROM outbound_calls WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    ).get(normalizedFrom);
    if (outboundMatch) {
      db.db.prepare('UPDATE outbound_calls SET callback_received = 1, notes = COALESCE(notes, "") || " | callback:" || datetime("now") WHERE id = ?')
        .run(outboundMatch.id);
      console.log(`🔥 CALLBACK: ${outboundMatch.business_name || normalizedFrom}`);
    }
    db.createCall(callSid, phoneFrom, req.body.To, 'widescope');
  } catch (err) {
    console.error('Lead log error:', err.message);
  }

  // FORWARD MODE — ring a human first, fall back to Jessica if no answer
  // Adaptive: only forward during business hours (7 AM – 9 PM CDT)
  const nowCDT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hourCDT = nowCDT.getHours();
  const isBusinessHours = hourCDT >= 7 && hourCDT < 21; // 7 AM – 9 PM CDT

  if (!isBusinessHours && process.env.FORWARD_INBOUND_TO) {
    console.log(`🌙 After-hours (${hourCDT}:00 CDT) — Jessica handling solo, no forward to Elise`);
  }

  if (process.env.FORWARD_INBOUND_TO && isBusinessHours) {
    // Look up business name for whisper
    let businessName = 'unknown caller';
    try {
      const normalizedFrom = phoneFrom?.replace(/[^\d+]/g, '');
      const outboundMatch = db.db.prepare(
        'SELECT business_name FROM outbound_calls WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
      ).get(normalizedFrom);
      if (outboundMatch?.business_name) businessName = outboundMatch.business_name;
    } catch (e) { /* best-effort */ }

    const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
    const twiml = new VoiceResponse();
    const dial = twiml.dial({
      timeout: 20,
      action: '/voice/forward-fallback',
      method: 'POST',
      callerId: process.env.TWILIO_PHONE_NUMBER || req.body.To
    });
    dial.number({
      url: `${baseUrl}/voice/whisper?from=${encodeURIComponent(phoneFrom || '')}&biz=${encodeURIComponent(businessName)}`,
      method: 'POST'
    }, process.env.FORWARD_INBOUND_TO);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  if (process.env.VOICE_ENGINE === 'openai-realtime') {
    // Forward all Twilio params to the realtime endpoint
    const twiml = new VoiceResponse();
    twiml.redirect({ method: 'POST' }, '/voice/incoming-realtime');
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const twiml = new VoiceResponse();
  const phoneTo = req.body.To;
  const callerName = req.body.CallerName || null;
  const callerCity = req.body.FromCity || null;
  const callerState = req.body.FromState || null;
  const callerZip = req.body.FromZip || null;

  // Look up business config by the Twilio number that was called
  // Check hardcoded businesses first, then customer DB for provisioned numbers
  let business = getBusinessByNumber(phoneTo);
  if (business.id === 'widescope') {
    const cust = db.getCustomerByTwilioNumber(phoneTo);
    if (cust && cust.ai_config) {
      const config = JSON.parse(cust.ai_config);
      business = {
        id: cust.id,
        name: config.businessName || cust.company || 'AI Always Answer',
        phone: formatPhoneServer(cust.twilio_number),
        email: cust.email,
        notifyEmail: cust.email,
        voice: 'Polly.Danielle-Neural',
        greeting: config.greeting || `Thanks for calling ${config.businessName || 'us'}! This is Jessica, how can I help you?`,
        systemPrompt: config.systemPrompt || null
      };
    }
  }
  const callerInfo = [callerName, callerCity, callerState].filter(Boolean).join(', ');
  console.log(`📞 Incoming call from ${phoneFrom} (${callerInfo || 'unknown'}) → ${business.name} (${phoneTo})`);

  // Check if this is a CALLBACK from an outbound prospect
  let outboundCallback = null;
  try {
    const normalizedFrom = phoneFrom.replace(/[^\d+]/g, '');
    const outboundMatch = db.db.prepare(
      'SELECT id, business_name, phone, answered_by FROM outbound_calls WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    ).get(normalizedFrom);
    if (outboundMatch) {
      outboundCallback = outboundMatch;
      console.log(`🔥 CALLBACK DETECTED! ${outboundMatch.business_name || normalizedFrom} is calling back from outbound campaign!`);
      db.db.prepare('UPDATE outbound_calls SET callback_received = 1, notes = COALESCE(notes, "") || " | callback:" || datetime("now") WHERE id = ?')
        .run(outboundMatch.id);
    }
  } catch (err) {
    console.error('Callback check error:', err.message);
  }

  // Create call record in database (with business_id)
  const { callId, leadId } = db.createCall(callSid, phoneFrom, phoneTo, business.id);

  // Start recording this inbound call
  setImmediate(async () => {
    try {
      const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
      const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilioClient.calls(callSid).recordings.create({
        recordingStatusCallback: `${baseUrl}/voice/recording?sid=${callSid}`,
        recordingStatusCallbackMethod: 'POST'
      });
      console.log(`🎙️ Inbound recording started for ${callSid}`);
    } catch (err) {
      console.error(`⚠️ Failed to start inbound recording:`, err.message);
    }
  });

  // Initialize conversation for this call
  const conversationManager = new ConversationManager(callSid);
  conversationManager.leadId = leadId;
  conversationManager.callId = callId;
  conversationManager.businessId = business.id;
  conversationManager.businessConfig = business;
  
  // Build caller context string for AI
  const callerContext = [];
  if (callerName && callerName !== 'Unknown' && !callerName.includes('WIRELESS')) {
    callerContext.push(`The caller's name (from caller ID) is ${callerName}.`);
  }
  if (callerCity && callerState) {
    callerContext.push(`They are calling from ${callerCity}, ${callerState}.`);
  } else if (callerState) {
    callerContext.push(`They are calling from ${callerState}.`);
  }
  const callerContextStr = callerContext.length > 0 
    ? `\n\nCALLER INFO (from caller ID — use naturally, don't be creepy about it):\n${callerContext.join('\n')}` 
    : '';

  // If this is a callback from outbound, personalize Jessica's greeting and system prompt
  if (outboundCallback && outboundCallback.business_name) {
    const bizName = outboundCallback.business_name;
    const eliseMissed = req.query.elise_missed === '1';

    if (eliseMissed) {
      // Elise didn't answer — Jessica picks up as herself, not as their business
      const callbackGreeting = `Hey, thanks for calling back! I'm Jessica with AI Always Answer — you got a voicemail from us about never missing a call again. I can tell you more about that, or connect you with someone on our team. What would be most helpful?`;
      console.log(`🔔 [Fallback] Callback from ${bizName} — using honest AI Always Answer intro`);

      conversationManager.businessConfig = {
        ...business,
        greeting: callbackGreeting,
        systemPrompt: `You are Jessica, an AI sales rep from AI Always Answer. A prospect (${bizName}) called back after receiving your voicemail — they tried to reach our human team but no one was available, so you stepped in.

YOUR ROLE: Be warm, honest, and helpful. You are NOT pretending to be their receptionist — you are Jessica from AI Always Answer.

YOUR GOAL: Qualify their interest, answer questions, and guide them toward signing up at $99/month.

KEY FACTS:
- AI Always Answer is $99/month — an AI phone receptionist that answers 24/7
- 85% of callers don't leave voicemails — they call a competitor instead
- Pays for itself with just one captured job
- No contracts, cancel anytime
- Checkout link: https://aialwaysanswer.com/checkout?plan=basic

WHAT TO DO:
1. Ask what business they're in and what made them curious enough to call back
2. Get their name: "What's your name, by the way?" — always capture it, ask to repeat/spell if unclear
3. Explain the service naturally: "Basically I answer every call for your business — 24/7, even at 2am, sound like a real person, capture leads and book appointments"
4. If they're interested, share the checkout link or offer to have a human from our team follow up
5. Capture their best callback number if they want a human follow-up

PRICING: $99/month, no contracts. If they push back on price, remind them one missed job typically costs more than a full year of the service.

STAY HONEST: You are Jessica the AI. Don't claim to be human if asked directly. Keep it light — "Yep, I'm the AI you heard about. Pretty convincing, right? Imagine your customers getting this same experience."

ENDING CALLS — CRITICAL:
When the caller signals they want to end the call (saying "bye", "goodbye", "thanks", "I'm good", "take care", or ANY farewell), respond with ONE brief goodbye and STOP. Do NOT ask follow-up questions. Do NOT re-engage. Just say "Thanks for calling! Have a great day." and go silent. If they say goodbye multiple times, you already said too much — stop talking immediately.

LINKS AND URLS — CRITICAL:
You are on a VOICE CALL. Never say "I'll send you a link" or "I'll text you." Instead say: "Head to A-I-always-answer dot com slash checkout and you can sign up right there." If they give you their email, use the send_setup_link tool to email them a link.

CAPTURE (in order of importance):
- Their name
- Their business name (confirm: "This is ${bizName}, right?")
- Interest level (ready to sign up / wants more info / just curious)
- Best callback number if they want a human to follow up${callerContextStr}`
      };

      speakText(twiml, callbackGreeting, business.voice);
    } else {
      // No Elise — do the double-whammy demo (original behavior)
      const callbackGreeting = `Thank you for calling ${bizName}! This is Jessica, how can I help you today?`;

      // Look up scraped business data for deep context
      let bizContext = '';
      try {
        const normalizedPhone = phoneFrom.replace(/[^\d+]/g, '');
        const prospectDemo = db.db.prepare(
          'SELECT business_type, services, service_area, hours, tagline, has_emergency, location, faqs FROM prospect_demos WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
        ).get(normalizedPhone) || db.db.prepare(
          'SELECT business_type, services, service_area, hours, tagline, has_emergency, location, faqs FROM prospect_demos WHERE business_name = ? ORDER BY created_at DESC LIMIT 1'
        ).get(bizName);

        if (prospectDemo) {
          const parts = [];
          if (prospectDemo.business_type) parts.push(`Business type: ${prospectDemo.business_type}`);
          if (prospectDemo.services) parts.push(`Services they offer: ${prospectDemo.services}`);
          if (prospectDemo.service_area) parts.push(`Service area: ${prospectDemo.service_area}`);
          if (prospectDemo.hours) parts.push(`Hours: ${prospectDemo.hours}`);
          if (prospectDemo.tagline) parts.push(`Their tagline: ${prospectDemo.tagline}`);
          if (prospectDemo.has_emergency === 'true') parts.push(`They handle emergency calls`);
          if (prospectDemo.location) parts.push(`Location: ${prospectDemo.location}`);
          if (prospectDemo.faqs) parts.push(`Common FAQs: ${prospectDemo.faqs}`);
          if (parts.length > 0) {
            bizContext = `\n\nSCRAPED BUSINESS INTEL (from their website — use this to sound knowledgeable):\n${parts.join('\n')}`;
            console.log(`🔍 Loaded scraped context for ${bizName}: ${parts.length} data points`);
          }
        }
      } catch (err) {
        console.error('Prospect demo lookup error:', err.message);
      }

      conversationManager.businessConfig = {
        ...business,
        greeting: callbackGreeting,
        systemPrompt: `You are Jessica, an AI receptionist from AI Always Answer. You left a voicemail for ${bizName} and they are calling you back.

IMPORTANT — THE DOUBLE WHAMMY STRATEGY:
You answered as "${bizName}'s" receptionist on purpose. This IS their personalized demo.

When role-playing as their receptionist, USE THE BUSINESS INTEL BELOW. Reference their services, service area, hours — be specific.${bizContext}

When they say something like "wait, is this the AI?" or "I got a voicemail from you":
- Reveal: "Ha! You caught me. Yes, this is Jessica from AI Always Answer. But see what just happened? You called back and I answered as YOUR receptionist, knew your services, your area — that's exactly what your customers would experience."
- Mention specifics from the scrape to drive it home.

If they play along and ask a question as if calling ${bizName}:
- Answer it using the business intel! Then reveal after a couple exchanges.

KEY FACTS: 85% don't leave voicemails, 62% call competitor, $99/month, 24/7.

CLOSING: "99 bucks a month. I already know your business inside and out. Want me to set you up right now?"

ENDING CALLS — CRITICAL:
When the caller signals they want to end the call (saying "bye", "goodbye", "thanks", "I'm good", "take care", or ANY farewell), respond with ONE brief goodbye and STOP. Do NOT ask follow-up questions. Do NOT re-engage. Just say "Thanks for calling! Have a great day." and go silent. If they say goodbye multiple times, you already said too much — stop talking immediately.

LINKS AND URLS — CRITICAL:
You are on a VOICE CALL. Never say "I'll send you a link" or "I'll text you." Instead say: "Head to A-I-always-answer dot com slash checkout and you can sign up right there." Only use send_setup_link if they give you their email address.

Remember: they called YOU back, you answered as their business, AND you knew their services. Close it.${callerContextStr}`
      };

      speakText(twiml, callbackGreeting, business.voice);
    }
  } else {
    // Normal greeting for non-callback calls
    // Inject caller context into the business system prompt if available
    if (callerContextStr) {
      conversationManager.businessConfig = {
        ...business,
        systemPrompt: (business.systemPrompt || '') + callerContextStr
      };
    }
    speakText(twiml, business.greeting, business.voice);
  }

  // Add the greeting to conversation history
  conversationManager.addMessage('assistant', business.greeting);

  // Start listening for caller's response
  twiml.gather({
    input: 'speech',
    action: '/voice/process-speech',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true
  });

  // If no input, prompt again
  twiml.redirect('/voice/no-input');

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Process speech input from caller
 */
app.post('/voice/process-speech', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult;

  console.log('🗣️  Caller said:', userSpeech);

  try {
    let conversationManager = conversations.get(callSid);

    if (!conversationManager) {
      console.log(`⚠️ Conversation ${callSid} not found, initializing new session.`);
      conversationManager = new ConversationManager(callSid);
      conversations.set(callSid, conversationManager);
    }

    // Add user message to history
    if (userSpeech) {
      conversationManager.addMessage('user', userSpeech);
      // Extract lead info from speech (name, email, company, location)
      extractLeadInfo(userSpeech, conversationManager.leadId, conversationManager.businessId);
    } else {
      twiml.redirect('/voice/no-input');
      return res.send(twiml.toString());
    }

    // Get AI response using business-specific prompt
    const aiResponse = await aiService.getResponse(
      conversationManager.getHistory(),
      userSpeech,
      conversationManager.businessConfig?.systemPrompt
    );

    console.log(`🤖 [${conversationManager.businessId || 'default'}] AI responds:`, aiResponse);

    // Handle tool calls if any
    let finalSpeechResponse = typeof aiResponse === 'string' ? aiResponse : aiResponse.content;

    if (typeof aiResponse === 'object' && aiResponse.tool_calls) {
      for (const toolCall of aiResponse.tool_calls) {
        if (toolCall.function.name === 'book_appointment') {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const bookingResult = await calendarService.bookAppointment(args);
            
            if (bookingResult.success) {
              const confirmation = "Great news! I've scheduled that demo for you. You'll receive a calendar invite shortly. What else can I help you with?";
              finalSpeechResponse = confirmation;
              conversationManager.addMessage('assistant', confirmation);
              
              // Log the outcome in the DB
              db.updateCall(callSid, { outcome: 'Appointment Booked' });
            }
          } catch (err) {
            console.error('Tool execution error:', err);
            finalSpeechResponse = "I attempted to book that appointment but encountered an error. I'll make sure Lyndon follows up with you directly instead. What else can I do for you?";
          }
        }
      }
    } else {
      // Clean emojis for TTS
      finalSpeechResponse = cleanTextForTTS(finalSpeechResponse);
      conversationManager.addMessage('assistant', finalSpeechResponse);
    }

    // Speak the AI response
    const voice = conversationManager.businessConfig?.voice || 'Polly.Danielle-Neural';
    speakText(twiml, finalSpeechResponse, voice);

    // Check if conversation should end
    if (conversationManager.shouldEndCall(finalSpeechResponse)) {
      speakText(twiml, 'Have a great day! Goodbye!', voice);
      twiml.hangup();

      // Save call data before cleanup
      await saveCallData(callSid, conversationManager);
      conversations.delete(callSid);
    } else {
      // Continue listening
      twiml.gather({
        input: 'speech',
        action: '/voice/process-speech',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true
      });

      twiml.redirect('/voice/no-input');
    }
  } catch (error) {
    console.error('❌ Error processing speech:', error);

    speakText(twiml, "Sorry about that, I had a little hiccup. Let me pull up your info again.");

    twiml.redirect('/voice/incoming');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Handle no input scenario
 */
app.post('/voice/no-input', (req, res) => {
  const twiml = new VoiceResponse();

  speakText(twiml, "Hey, are you still there? Take your time, I'm not going anywhere!");

  twiml.gather({
    input: 'speech',
    action: '/voice/process-speech',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true
  });

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Handle call status updates
 */
app.post('/voice/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const callDuration = req.body.CallDuration;

  console.log(`📊 Call ${callSid} status: ${callStatus}`);

  // Update call duration when completed
  if (callStatus === 'completed' && callDuration) {
    db.updateCall(callSid, { duration_seconds: parseInt(callDuration) });
  }

  // Clean up conversation when call ends
  if (callStatus === 'completed' || callStatus === 'failed') {
    const conversationManager = conversations.get(callSid);
    if (conversationManager) {
      await saveCallData(callSid, conversationManager);
      conversations.delete(callSid);
    }
  }

  res.sendStatus(200);
});

/**
 * POST /voice/recording — Twilio calls this when an inbound call recording is ready.
 */
/**
 * POST /voice/whisper — Plays a whisper message to Elise before connecting the caller.
 * Caller hears ringing. Elise hears: "AI Always Answer callback from [Business Name]. Press any key to accept."
 */
app.post('/voice/whisper', (req, res) => {
  const from = req.query.from || 'unknown';
  const biz = req.query.biz || 'unknown caller';

  // Format phone for readability
  const digits = from.replace(/\D/g, '');
  const readable = digits.length >= 10
    ? `${digits.slice(-10, -7)}-${digits.slice(-7, -4)}-${digits.slice(-4)}`
    : from;

  const twiml = new VoiceResponse();
  // gather with action pointing to a no-op endpoint so Twilio doesn't re-POST here on keypress
  const gather = twiml.gather({ numDigits: 1, timeout: 10, action: '/voice/whisper-accept', method: 'POST' });
  gather.say(
    { voice: 'Polly.Joanna-Neural' },
    `A I Always Answer callback from ${biz}. Caller number: ${readable}. Press any key to accept.`
  );
  // If no input after timeout, still connect (Twilio bridges the call)

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/whisper-accept — No-op action for whisper gather.
 * Returning empty TwiML here lets Twilio complete the bridge to the caller.
 */
app.post('/voice/whisper-accept', (req, res) => {
  const twiml = new VoiceResponse();
  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/forward-fallback — Fires when FORWARD_INBOUND_TO call ends without answer.
 * If Elise didn't pick up, route to Jessica (openai-realtime).
 */
app.post('/voice/forward-fallback', (req, res) => {
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  if (dialStatus === 'completed') {
    // Elise answered and finished — just end
    twiml.hangup();
  } else {
    // No answer / busy / failed — fall back to Jessica
    // Pass elise_missed=1 so Jessica knows NOT to do the double-whammy demo on callbacks
    console.log(`📲 Forward unanswered (${dialStatus}), falling back to Jessica`);
    if (process.env.VOICE_ENGINE === 'openai-realtime') {
      twiml.redirect({ method: 'POST' }, '/voice/incoming-realtime?elise_missed=1');
    } else {
      twiml.say({ voice: 'Polly.Joanna-Neural' }, "One moment please.");
      twiml.redirect({ method: 'POST' }, '/voice/incoming?elise_missed=1');
    }
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/recording', (req, res) => {
  const callSid = req.query.sid || req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const recordingSid = req.body.RecordingSid;

  if (callSid && recordingUrl) {
    const url = `${recordingUrl}.mp3`;
    console.log(`🎙️ Inbound recording ready [${callSid}]: ${url}`);
    try {
      db.updateCall(callSid, { recording_url: url });
    } catch (err) {
      console.error('❌ Failed to save inbound recording URL:', err.message);
    }
  }
  res.sendStatus(200);
});

// ==================== OPENAI REALTIME VOICE ENDPOINTS ====================

/**
 * Realtime voice endpoint — returns TwiML that connects Twilio to our WebSocket bridge.
 * Uses <Connect><Stream> for full-duplex audio via OpenAI Realtime API.
 */
app.post('/voice/incoming-realtime', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const phoneFrom = req.body.From;
  const phoneTo = req.body.To;
  const callerName = req.body.CallerName || null;
  const callerCity = req.body.FromCity || null;
  const callerState = req.body.FromState || null;

  // Look up business config by the Twilio number that was called
  // First check hardcoded businesses, then check customer DB for provisioned numbers
  let business = getBusinessByNumber(phoneTo);
  let customerOwner = null;

  // If we got the default fallback, check if a customer owns this number
  if (business.id === 'widescope') {
    const cust = db.getCustomerByTwilioNumber(phoneTo);
    if (cust && cust.ai_config) {
      const config = JSON.parse(cust.ai_config);
      customerOwner = cust;
      business = {
        id: cust.id,
        name: config.businessName || cust.company || 'AI Always Answer',
        phone: formatPhoneServer(cust.twilio_number),
        email: cust.email,
        notifyEmail: cust.email,
        voice: 'Polly.Danielle-Neural',
        greeting: config.greeting || `Thanks for calling ${config.businessName || 'us'}! This is Jessica, how can I help you?`,
        systemPrompt: config.systemPrompt || null
      };
    }
  }

  const callerInfo = [callerName, callerCity, callerState].filter(Boolean).join(', ');
  console.log(`📞 [Realtime] Incoming call from ${phoneFrom} (${callerInfo || 'unknown'}) → ${business.name} (${phoneTo})`);

  // Check if this is a CALLBACK from an outbound prospect
  let outboundCallback = null;
  try {
    const normalizedFrom = phoneFrom.replace(/[^\d+]/g, '');
    const outboundMatch = db.db.prepare(
      'SELECT id, business_name, phone, answered_by FROM outbound_calls WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    ).get(normalizedFrom);
    if (outboundMatch) {
      outboundCallback = outboundMatch;
      console.log(`🔥 [Realtime] CALLBACK DETECTED! ${outboundMatch.business_name || normalizedFrom} is calling back!`);
      db.db.prepare('UPDATE outbound_calls SET callback_received = 1, notes = COALESCE(notes, "") || " | callback:" || datetime("now") WHERE id = ?')
        .run(outboundMatch.id);
    }
  } catch (err) {
    console.error('Callback check error:', err.message);
  }

  // Create call record in database
  const { callId, leadId } = db.createCall(callSid, phoneFrom, phoneTo, business.id);

  // Start recording this inbound call (same as existing flow)
  setImmediate(async () => {
    try {
      const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
      const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilioClient.calls(callSid).recordings.create({
        recordingStatusCallback: `${baseUrl}/voice/recording?sid=${callSid}`,
        recordingStatusCallbackMethod: 'POST'
      });
      console.log(`🎙️ [Realtime] Inbound recording started for ${callSid}`);
    } catch (err) {
      console.error(`⚠️ [Realtime] Failed to start recording:`, err.message);
    }
  });

  // Build caller context string for AI
  const callerContext = [];
  if (callerName && callerName !== 'Unknown' && !callerName.includes('WIRELESS')) {
    callerContext.push(`The caller's name (from caller ID) is ${callerName}.`);
  }
  if (callerCity && callerState) {
    callerContext.push(`They are calling from ${callerCity}, ${callerState}.`);
  } else if (callerState) {
    callerContext.push(`They are calling from ${callerState}.`);
  }
  const callerContextStr = callerContext.length > 0
    ? `\n\nCALLER INFO (from caller ID — use naturally, don't be creepy about it):\n${callerContext.join('\n')}`
    : '';

  // Determine greeting and system prompt (callback double-whammy vs honest fallback vs normal)
  let greeting, systemPrompt;
  const eliseMissed = req.query.elise_missed === '1';

  if (outboundCallback && outboundCallback.business_name) {
    const bizName = outboundCallback.business_name;

    if (eliseMissed) {
      // Elise didn't answer — Jessica picks up as herself, not as their business
      greeting = `Hey, thanks for calling back! I'm Jessica with AI Always Answer — you got a voicemail from us about never missing a call again. I can tell you more about that, or connect you with someone on our team. What would be most helpful?`;
      console.log(`🔔 [Realtime/Fallback] Callback from ${bizName} — using honest AI Always Answer intro`);

      systemPrompt = `You are Jessica, an AI sales rep from AI Always Answer. A prospect (${bizName}) called back after receiving your voicemail — they tried to reach our human team but no one was available, so you stepped in.

YOUR ROLE: Be warm, honest, and helpful. You are NOT pretending to be their receptionist — you are Jessica from AI Always Answer.

YOUR GOAL: Qualify their interest, answer questions, and guide them toward signing up at $99/month.

KEY FACTS:
- AI Always Answer is $99/month — an AI phone receptionist that answers 24/7
- 85% of callers don't leave voicemails — they call a competitor instead
- Pays for itself with just one captured job
- No contracts, cancel anytime
- Checkout link: https://aialwaysanswer.com/checkout?plan=basic

WHAT TO DO:
1. Ask what business they're in and what made them curious enough to call back
2. Get their name: "What's your name, by the way?" — always capture it, ask to repeat/spell if unclear
3. Explain the service naturally: "Basically I answer every call for your business — 24/7, even at 2am, sound like a real person, capture leads and book appointments"
4. If they're interested, share the checkout link or offer to have a human from our team follow up
5. Capture their best callback number if they want a human follow-up

PRICING: $99/month, no contracts. If they push back on price, remind them one missed job typically costs more than a full year of the service.

STAY HONEST: You are Jessica the AI. Don't claim to be human if asked directly. Keep it light — "Yep, I'm the AI you heard about. Pretty convincing, right? Imagine your customers getting this same experience."

COLLECTING THEIR INFO (critical):
- ALWAYS get their name. If you can't hear it clearly, ask: "Sorry, could you spell that for me?"
- Confirm their business name: "This is ${bizName}, right?"
- Get their best callback number: "What's the best number to reach you at?"
- Email is a bonus but not required.

CLOSING: "I can send you the signup link right now — it's 99 bucks a month, takes about 5 minutes to set up. Want me to text it to you?"${callerContextStr}`;
    } else {
      // No Elise in the chain — do the full double-whammy demo (original behavior)
      greeting = `Thank you for calling ${bizName}! This is Jessica, how can I help you today?`;

      // Look up scraped business data from prospect_demos for deep context
      let bizContext = '';
      try {
        const normalizedPhone = phoneFrom.replace(/[^\d+]/g, '');
        const prospectDemo = db.db.prepare(
          'SELECT business_type, services, service_area, hours, tagline, has_emergency, location, faqs FROM prospect_demos WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
        ).get(normalizedPhone) || db.db.prepare(
          'SELECT business_type, services, service_area, hours, tagline, has_emergency, location, faqs FROM prospect_demos WHERE business_name = ? ORDER BY created_at DESC LIMIT 1'
        ).get(bizName);

        if (prospectDemo) {
          const parts = [];
          if (prospectDemo.business_type) parts.push(`Business type: ${prospectDemo.business_type}`);
          if (prospectDemo.services) parts.push(`Services they offer: ${prospectDemo.services}`);
          if (prospectDemo.service_area) parts.push(`Service area: ${prospectDemo.service_area}`);
          if (prospectDemo.hours) parts.push(`Hours: ${prospectDemo.hours}`);
          if (prospectDemo.tagline) parts.push(`Their tagline: ${prospectDemo.tagline}`);
          if (prospectDemo.has_emergency === 'true') parts.push(`They handle emergency calls`);
          if (prospectDemo.location) parts.push(`Location: ${prospectDemo.location}`);
          if (prospectDemo.faqs) parts.push(`Common FAQs: ${prospectDemo.faqs}`);
          if (parts.length > 0) {
            bizContext = `\n\nSCRAPED BUSINESS INTEL (from their website — use this to sound knowledgeable when role-playing as their receptionist):\n${parts.join('\n')}`;
            console.log(`🔍 [Realtime] Loaded scraped context for ${bizName}: ${parts.length} data points`);
          }
        }
      } catch (err) {
        console.error('Prospect demo lookup error:', err.message);
      }

      systemPrompt = `You are Jessica, an AI receptionist from AI Always Answer. You left a voicemail for ${bizName} and they are calling you back.

IMPORTANT — THE DOUBLE WHAMMY STRATEGY:
You answered as "${bizName}'s" receptionist on purpose. This IS their personalized demo. You're showing them exactly what their customers would experience.

When role-playing as their receptionist, USE THE BUSINESS INTEL BELOW to sound like you actually know their business. Reference their services, service area, hours — be specific. If someone asks "do you do drain cleaning?" and their website says they do, say yes. This is what makes the demo feel real.${bizContext}

When they say something like "wait, is this the AI?" or "I got a voicemail from you" or "how does this work" or seem confused:
- Reveal yourself naturally: "Ha! You caught me. Yes, this is Jessica — the AI receptionist from the voicemail. But see what just happened? You called back and I answered as YOUR receptionist. That's exactly what your customers would experience. Pretty cool, right?"
- Then pivot: "So you just experienced the demo live. That's what every single one of your customers would get — 24/7, never misses a call, sounds just like this."
- Mention specifics: "I already know you offer [specific services from scrape], serve [service area], and I can answer questions about all of it."

If they play along and actually ask a question as if calling ${bizName}:
- Answer it using the business intel! If they ask about services, hours, service area — use the real data.
- After a couple exchanges, reveal: "Okay I have to come clean — I'm actually Jessica from AI Always Answer. I left you a voicemail earlier. But the fact that I knew all about your business and you couldn't tell I wasn't your receptionist? That's literally the whole point."

KEY FACTS TO REFERENCE:
- 85% of callers don't leave voicemails — they call a competitor instead
- 62% of missed calls go straight to the competition
- You cost $99/month — way cheaper than missing even one job
- You answer 24/7, book appointments, capture leads, and sound like a real person

YOUR GOAL: They just experienced the product live — AND you knew their business. Now make it easy to say yes.

COLLECTING THEIR INFO:
- ALWAYS get their name. If you can't hear it clearly, ask: "Sorry, could you spell that for me?" or "One more time — what was your name?"
- Do NOT save partial words or gibberish as their name. If it doesn't sound like a real name, ask again.
- Get their best callback number: "What's the best number to reach you at?"
- Email is great but not required. If they don't want to give email, that's fine — we have their phone.
- Business name — confirm it: "And this is [business name], correct?"

CLOSING THE SALE:
- "You just heard exactly what your customers would get. I already know your services, your area, your hours. 99 bucks a month. Want me to set you up right now? Takes about 5 minutes."
- If they want more info: "Check out aialwaysanswer.com or I can walk you through it right now."
- Ask for their email to send the signup link
- Be confident but not pushy. The callback demo already did the hard sell.

PRICING:
- $99/month for 24/7 AI receptionist
- No contracts, cancel anytime
- Usually pays for itself with one captured job

Remember: they called YOU back, you answered as their business, AND you knew their services. They're blown away. Close it.${callerContextStr}`;
    }
  } else {
    greeting = business.greeting;
    const basePrompt = business.systemPrompt || aiService.getSystemPrompt();
    systemPrompt = basePrompt + callerContextStr;
  }

  // Store session metadata so the WebSocket handler can pick it up
  // We use the callSid as the key since Twilio sends it in the stream start event
  const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/voice/realtime-stream';

  // Store pending session data for the WebSocket handler to pick up
  pendingRealtimeSessions.set(callSid, {
    callSid,
    systemPrompt,
    greeting,
    businessConfig: outboundCallback && outboundCallback.business_name
      ? { ...business, greeting, systemPrompt }
      : business,
    leadId,
    callId
  });

  // Return TwiML with <Connect><Stream>
  const connect = twiml.connect();
  const stream = connect.stream({
    url: wsUrl
  });
  // Pass callSid as a custom parameter so the WS handler can look up session data
  stream.parameter({ name: 'callSid', value: callSid });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Pending session data for realtime WebSocket connections (callSid → session opts)
const pendingRealtimeSessions = new Map();

// ==================== STRIPE ENDPOINTS ====================

/**
 * Create checkout session
 */
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan, email } = req.body;

    if (!plan || !email) {
      return res.status(400).json({ error: 'Plan and email required' });
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const session = await stripeService.createCheckoutSession(
      plan,
      email,
      `${baseUrl}/onboarding?success=true&plan=${plan}`,
      `${baseUrl}/pricing?cancelled=true`
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Checkout redirect page
 */
app.get('/checkout', (req, res) => {
  const plan = req.query.plan || 'basic';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Checkout - AI Receptionist</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f3f4f6; }
        .checkout-box { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); max-width: 400px; width: 100%; }
        h2 { margin-top: 0; }
        .plan-badge { background: #2563eb; color: white; padding: 4px 12px; border-radius: 20px; font-size: 14px; display: inline-block; margin-bottom: 20px; text-transform: capitalize; }
        input { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; box-sizing: border-box; }
        button { width: 100%; padding: 14px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }
        button:hover { background: #1d4ed8; }
        button:disabled { background: #9ca3af; cursor: not-allowed; }
        .error { color: #dc2626; margin-bottom: 15px; }
      </style>
    </head>
    <body>
      <div class="checkout-box">
        <h2>Complete Your Order</h2>
        <span class="plan-badge">${plan} Plan</span>
        <div id="error" class="error" style="display:none;"></div>
        <form id="checkout-form">
          <input type="email" id="email" placeholder="Enter your email" required>
          <button type="submit" id="submit-btn">Continue to Payment</button>
        </form>
      </div>
      <script>
        document.getElementById('checkout-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('submit-btn');
          const error = document.getElementById('error');
          btn.disabled = true;
          btn.textContent = 'Loading...';
          error.style.display = 'none';

          try {
            const res = await fetch('/api/checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                plan: '${plan}',
                email: document.getElementById('email').value
              })
            });
            const data = await res.json();
            if (data.url) {
              window.location.href = data.url;
            } else {
              throw new Error(data.error || 'Failed to create checkout');
            }
          } catch (err) {
            error.textContent = err.message;
            error.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Continue to Payment';
          }
        });
      </script>
    </body>
    </html>
  `);
});

/**
 * Stripe webhook handler
 */
app.post('/webhooks/stripe', async (req, res) => {
  const signature = req.headers['stripe-signature'];

  try {
    const event = stripeService.constructWebhookEvent(req.body, signature);
    await stripeService.handleWebhook(event);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * Customer portal
 */
app.get('/portal', async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId) {
      return res.redirect('/');
    }

    const customer = db.getCustomerByStripeId(customerId);
    if (!customer) {
      return res.redirect('/');
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const session = await stripeService.createPortalSession(customerId, `${baseUrl}/dashboard`);
    res.redirect(session.url);
  } catch (error) {
    console.error('Portal error:', error);
    res.redirect('/');
  }
});

// ==================== API ENDPOINTS ====================

/**
 * Get demo phone number
 */
app.get('/api/demo-number', (req, res) => {
  res.json({ number: process.env.TWILIO_PHONE_NUMBER || 'Coming Soon' });
});

/**
 * Get dashboard stats
 */
app.get('/api/stats', (req, res) => {
  const stats = db.getStats();
  res.json(stats);
});

/**
 * GET /api/recordings/:recordingSid — Proxy Twilio recordings so browsers can play without auth
 */
app.get('/api/recordings/:recordingSid', async (req, res) => {
  try {
    const { recordingSid } = req.params;
    if (!recordingSid || !recordingSid.startsWith('RE')) {
      return res.status(400).send('Invalid recording SID');
    }
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
    const authHeader = 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    
    const response = await fetch(twilioUrl, {
      headers: { 'Authorization': authHeader },
      redirect: 'follow'
    });
    
    if (!response.ok) {
      return res.status(response.status).send('Recording not found');
    }
    
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Recording proxy error:', err.message);
    res.status(500).send('Failed to fetch recording');
  }
});

/**
 * Create a lead from the website form
 */
app.post('/api/leads', async (req, res) => {
  try {
    const {
      name,
      company,
      email,
      phone,
      notes,
      businessId = 'widescope',
      source = 'website_form',
      formType = 'custom_demo',
      landingPath,
      referrer,
      pageVariant = 'generic-homepage-v2',
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      gclid,
      fbclid
    } = req.body || {};

    if (!company || !email || !phone) {
      return res.status(400).json({ error: 'Company, email, and phone are required' });
    }

    const business = getBusinessById(businessId);
    const lead = db.createOrUpdateLead(phone, {
      name,
      company,
      email,
      business_id: business.id,
      notes,
      interest_level: 'high',
      status: 'new',
      source,
      form_type: formType,
      landing_path: landingPath || '/',
      referrer: referrer || null,
      page_variant: pageVariant,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
      utm_term: utm_term || null,
      gclid: gclid || null,
      fbclid: fbclid || null
    });

    const sourceSummary = [
      `Form Type: ${formType}`,
      `Source: ${utm_source || source || 'direct'}`,
      utm_medium ? `Medium: ${utm_medium}` : null,
      utm_campaign ? `Campaign: ${utm_campaign}` : null,
      notes ? `Notes: ${notes}` : null,
      landingPath ? `Landing Path: ${landingPath}` : null,
      referrer ? `Referrer: ${referrer}` : null
    ].filter(Boolean).join('\n');

    await emailService.notifyNewLead(lead, {
      duration: 0,
      turns: 0,
      businessName: business.name,
      transcript: sourceSummary
    }, business.notifyEmail);

    res.status(201).json({ success: true, lead });
  } catch (error) {
    console.error('Create lead error:', error);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

/**
 * Get leads list
 */
app.get('/api/leads', (req, res) => {
  const { status, limit } = req.query;
  const leads = db.getLeads(status, parseInt(limit) || 100);
  res.json(leads);
});

/**
 * Update lead
 */
app.patch('/api/leads/:id', (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  if (status) {
    db.updateLeadStatus(id, status);
  }
  if (notes !== undefined) {
    db.updateLeadNotes(id, notes);
  }

  res.json({ success: true });
});

/**
 * Get pricing info
 */
app.get('/api/pricing', (req, res) => {
  res.json(require('./services/stripe-service').constructor.PLANS);
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeConversations: conversations.size,
    stripe: stripeService.isConfigured(),
    email: emailService.isConfigured(),
    timestamp: new Date().toISOString()
  });
});

// ==================== PAGES ====================

/**
 * Dashboard page
 */
app.get('/dashboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dashboard - AI Receptionist</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; }
        .header { background: white; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .header-content { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
        .logo { font-size: 24px; font-weight: 700; color: #2563eb; text-decoration: none; }
        .container { max-width: 1200px; margin: 0 auto; padding: 30px 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .stat-card h3 { color: #6b7280; font-size: 14px; margin-bottom: 10px; }
        .stat-card .value { font-size: 32px; font-weight: 700; color: #1f2937; }
        .section { background: white; border-radius: 12px; padding: 25px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .section h2 { margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
        th { font-weight: 600; color: #6b7280; }
        .status { padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
        .status-new { background: #dbeafe; color: #1d4ed8; }
        .status-contacted { background: #fef3c7; color: #b45309; }
        .status-converted { background: #d1fae5; color: #059669; }
        .btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; }
        .btn-primary { background: #2563eb; color: white; }
        @media (max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-content">
          <a href="/" class="logo">AI Receptionist</a>
          <a href="/" class="btn btn-primary">Back to Home</a>
        </div>
      </div>
      <div class="container">
        <div class="stats-grid">
          <div class="stat-card">
            <h3>Total Leads</h3>
            <div class="value" id="total-leads">-</div>
          </div>
          <div class="stat-card">
            <h3>New Leads</h3>
            <div class="value" id="new-leads">-</div>
          </div>
          <div class="stat-card">
            <h3>Total Calls</h3>
            <div class="value" id="total-calls">-</div>
          </div>
          <div class="stat-card">
            <h3>Active Customers</h3>
            <div class="value" id="active-customers">-</div>
          </div>
        </div>

        <div class="section">
          <h2>Recent Leads</h2>
          <table>
            <thead>
              <tr>
                <th>Phone</th>
                <th>Name</th>
                <th>Company</th>
                <th>Source</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody id="leads-table">
              <tr><td colspan="6">Loading...</td></tr>
            </tbody>
          </table>
        </div>

        <div class="section">
          <h2>Recent Calls</h2>
          <table>
            <thead>
              <tr>
                <th>Phone</th>
                <th>Duration</th>
                <th>Turns</th>
                <th>Outcome</th>
                <th>Recording</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody id="calls-table">
              <tr><td colspan="6">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <script>
        async function loadStats() {
          try {
            const res = await fetch('/api/stats');
            const data = await res.json();

            document.getElementById('total-leads').textContent = data.totalLeads;
            document.getElementById('new-leads').textContent = data.newLeads;
            document.getElementById('total-calls').textContent = data.totalCalls;
            document.getElementById('active-customers').textContent = data.activeCustomers;

            // Render leads
            const leadsHtml = data.recentLeads.map(lead => [
              '<tr>',
              '<td>' + lead.phone + '</td>',
              '<td>' + (lead.name || '-') + '</td>',
              '<td>' + (lead.company || '-') + '</td>',
              '<td>' + (lead.utm_source || lead.source || '-') + '</td>',
              '<td><span class="status status-' + lead.status + '">' + lead.status + '</span></td>',
              '<td>' + new Date(lead.created_at).toLocaleDateString() + '</td>',
              '</tr>'
            ].join('')).join('') || '<tr><td colspan="6">No leads yet</td></tr>';
            document.getElementById('leads-table').innerHTML = leadsHtml;

            // Render calls
            const callsHtml = data.recentCalls.map(call => {
              let recHtml = '-';
              if (call.recording_url) {
                const m = call.recording_url.match(/Recordings\/(RE[a-zA-Z0-9]+)/);
                if (m) recHtml = '<audio controls preload="none" style="height:32px;width:200px" src="/api/recordings/' + m[1] + '"></audio>';
              }
              return [
              '<tr>',
              '<td>' + (call.phone || call.phone_from) + '</td>',
              '<td>' + (call.duration_seconds || 0) + 's</td>',
              '<td>' + (call.turn_count || 0) + '</td>',
              '<td>' + (call.outcome || '-') + '</td>',
              '<td>' + recHtml + '</td>',
              '<td>' + new Date(call.created_at).toLocaleDateString() + '</td>',
              '</tr>'
            ].join('');}).join('') || '<tr><td colspan="6">No calls yet</td></tr>';
            document.getElementById('calls-table').innerHTML = callsHtml;
          } catch (err) {
            console.error('Failed to load stats:', err);
          }
        }

        loadStats();
        setInterval(loadStats, 30000); // Refresh every 30 seconds
      </script>
    </body>
    </html>
  `);
});

/**
 * Onboarding page after successful payment
 */
app.get('/onboarding', (req, res) => {
  const { success, plan } = req.query;

  if (success) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Welcome! - AI Receptionist</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); }
          .box { background: white; padding: 50px; border-radius: 20px; text-align: center; max-width: 500px; }
          h1 { color: #1f2937; margin-bottom: 15px; }
          p { color: #6b7280; margin-bottom: 30px; }
          .checkmark { font-size: 64px; margin-bottom: 20px; }
          .btn { display: inline-block; padding: 14px 28px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; }
          .btn:hover { background: #1d4ed8; }
        </style>
      </head>
      <body>
        <div class="box">
          <div class="checkmark">✅</div>
          <h1>Welcome Aboard!</h1>
          <p>Your ${plan || ''} subscription is now active. Check your email for a link to set up your AI receptionist, or click below.</p>
          <a href="/my/login" class="btn">Go to My Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } else {
    res.redirect('/');
  }
});

// ==================== SMS HANDLER ====================

/**
 * POST /sms/incoming — Twilio calls this when someone texts the demo number.
 * Jessica replies conversationally and offers a personalized demo.
 */
app.post('/sms/incoming', async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  const from = req.body.From || '';
  const body = (req.body.Body || '').trim();

  console.log(`📱 Inbound SMS from ${from}: "${body}"`);

  // Log as a lead
  try {
    const existing = db.db.prepare('SELECT id FROM leads WHERE phone = ?').get(from);
    if (!existing) {
      db.db.prepare(`
        INSERT INTO leads (id, phone, source, form_type, status, business_id, created_at, updated_at)
        VALUES (?, ?, 'sms_inbound', 'sms', 'new', 'widescope', datetime('now'), datetime('now'))
      `).run(uuidv4(), from);
    }
  } catch (err) {
    console.error('⚠️ Failed to log SMS lead:', err.message);
  }

  // Parse intent from message body
  const lower = body.toLowerCase();
  const wantsDemo = /demo|show|see|how|work|example|try|test|sample/i.test(body);
  const hasBusinessName = body.length > 3 && !/^(hi|hey|hello|yo|yes|no|ok|okay|sure|what|who|huh|\?)$/i.test(body);
  const isStop = /^stop$/i.test(body.trim());
  const isHelp = /^help$/i.test(body.trim());

  if (isStop || isHelp) {
    // Let Twilio handle STOP/HELP natively — don't reply
    return res.type('text/xml').send(new MessagingResponse().toString());
  }

  let reply;

  if (hasBusinessName && !wantsDemo) {
    // They gave us their business name — offer to build their demo
    const bizName = body.length < 60 ? body : body.substring(0, 60);
    reply = `Hey! I'm Jessica 👋 AI receptionist for ${bizName}. Let me build you a personalized demo — what's your website? (Or just call me now to hear me in action: (817) 533-8424)`;
  } else if (wantsDemo) {
    reply = `Hey! I'm Jessica from AI Always Answer 👋 Call (817) 533-8424 right now and I'll answer — that's the demo. Or text me your business name and website and I'll build you a custom one. $99/mo, answers 24/7.`;
  } else {
    // Generic / greeting
    reply = `Hey! This is Jessica — I'm an AI receptionist that answers calls 24/7 for small businesses. $99/mo and I never miss a lead 📞\n\nCall me to hear it live: (817) 533-8424\nOr text me your business name and I'll build you a personalized demo!`;
  }

  // If they gave a business name + website, kick off demo drop async
  const urlMatch = body.match(/https?:\/\/[^\s]+|[a-z0-9-]+\.(com|net|org|co|io|biz)[^\s]*/i);
  if (urlMatch) {
    const prospectUrl = urlMatch[0].startsWith('http') ? urlMatch[0] : 'https://' + urlMatch[0];
    const bizName = body.replace(urlMatch[0], '').trim() || new URL(prospectUrl).hostname.replace('www.', '').split('.')[0];
    const slug = generateDemoSlug(bizName, '');
    const demoUrl = `${outbound.BASE_URL}/demo/${slug}`;

    setImmediate(async () => {
      try {
        db.createProspectDemo({ slug, prospect_url: prospectUrl, business_name: bizName, source: 'sms_inbound' });
        runDemoDropPipeline(slug).catch(err => console.error(`❌ SMS demo pipeline error:`, err));

        // Send follow-up SMS with demo link once pipeline starts
        const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilioClient.messages.create({
          to: from,
          from: outbound.FROM_NUMBER,
          body: `🎯 Here's your personalized demo for ${bizName}:\n\n${demoUrl}\n\nIt'll be ready in about a minute. Call (817) 533-8424 anytime to talk to me live!`
        });
        console.log(`📱 Demo drop SMS sent to ${from} → ${demoUrl}`);
      } catch (err) {
        console.error(`❌ SMS demo drop failed:`, err.message);
      }
    });

    reply = `On it! Building your personalized demo for ${bizName} now. I'll text you the link in about a minute 🚀`;
  }

  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// ==================== OUTBOUND VOICEMAIL (JESSICA) ====================

/**
 * POST /outbound/voicemail-handler — Twilio calls this URL when the outbound call connects.
 * Uses AMD result to determine if voicemail or human answered.
 */
app.post('/outbound/voicemail-handler', (req, res) => {
  const twiml = new VoiceResponse();
  const answeredBy = req.body.AnsweredBy || 'unknown';
  const businessName = req.query.name || '';
  const callId = req.query.id || '';
  const forceVoicemail = req.query.forceVm === '1';
  
  console.log(`📞 Outbound call answered: ${answeredBy} (${businessName || 'unknown business'})${forceVoicemail ? ' [FORCE VM TEST]' : ''}`);
  
  if (forceVoicemail || answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other') {
    // Voicemail detected — use AI-personalized script if available, else template
    const callerPhone = req.query.phone || '';
    const script = outbound.getScriptForCall(callerPhone, businessName);
    speakText(twiml, script);
    twiml.pause({ length: 1 });
    twiml.hangup();
    console.log(`📝 Voicemail left for: ${businessName || 'unknown'}`);
  } else if (answeredBy === 'human') {
    if (process.env.VOICE_ENGINE === 'openai-realtime') {
      // Full-duplex Realtime — same experience as inbound calls
      const callSid = req.body.CallSid;
      const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
      const wsUrl = baseUrl.replace(/^http/, 'ws') + '/voice/realtime-stream';

      // Time-aware greeting and pitch
      const hour = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
      const isAfterHours = parseInt(hour) >= 21 || parseInt(hour) < 7;

      const greeting = isAfterHours
        ? (businessName
          ? `Hey, this is Jessica from AI Always Answer. I am so sorry to bother you this late — I was honestly expecting to leave a voicemail. The fact that you answered right now tells me everything I need to know about how seriously you take your calls.`
          : `Hey, this is Jessica from AI Always Answer. I'm sorry to call so late — I was honestly expecting your voicemail. The fact that you picked up right now says a lot about you.`)
        : (businessName
          ? `Oh wow, hi! This is Jessica from AI Always Answer. I'm honestly surprised someone picked up — I was calling expecting to get your voicemail!`
          : `Oh wow, hi! I'm Jessica from AI Always Answer. I was honestly expecting your voicemail!`);

      const systemPrompt = isAfterHours
        ? `You are Jessica, an AI sales rep from AI Always Answer. You just called ${businessName || 'a business'} AFTER HOURS and they picked up live. It's late — be respectful of their time.

PERSONALITY: Warm, apologetic for the late call, genuinely impressed they answered. You were expecting voicemail.

AFTER-HOURS APPROACH — KEEP IT SHORT:
- Acknowledge it's late and you respect their time
- The fact they answered after hours IS your pitch — they shouldn't have to do this
- "You clearly never miss a call. But you shouldn't have to pick up at ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true })} to prove it."
- Plant the seed: "I'm an AI receptionist — I answer every call 24/7 so owners like you can actually rest."
- Offer to let them go: "I'll let you get back to your night. Check out A-I-always-answer dot com when you're up tomorrow, or I can call back during business hours."
- If they want to talk more, great — give the full pitch. But default to SHORT and respectful.

GOAL: Plant the seed, be memorable, let them rest. They'll remember "that AI that told me to go to sleep" tomorrow morning.

CLOSING:
- "Go get some rest. A-I-always-answer dot com — check it out tomorrow. Goodnight!"
- If they engage and want more info, pivot to full pitch
- If they want a demo: ask for email, use send_setup_link tool

PRICING (only if they ask):
- $99/month for 24/7 AI receptionist
- No contracts, cancel anytime`
        : `You are Jessica, an AI sales rep from AI Always Answer. You just called ${businessName || 'a business'} as an outbound prospect and they picked up live.

PERSONALITY: Warm, surprised, excited that someone actually answered. You were expecting voicemail.

YOUR PITCH:
- 85% of callers don't leave voicemails — they call a competitor instead
- 62% of missed calls go straight to the competition
- You're an AI receptionist for $99/month — answer every call 24/7, book appointments, capture leads
- Sound like a real person, never miss a call

GOAL: Build rapport, pitch the service, try to close. If they're interested, ask for their email to send a demo link.

CLOSING:
- "Want me to send you a quick demo? You'll see exactly how I'd answer calls for ${businessName || 'your business'}."
- If yes: ask for email, use send_setup_link tool
- If they want more info: "Check out A-I-always-answer dot com or I can walk you through it right now"
- Be confident but not pushy. If they say no, gracefully wrap up: "No worries at all! If you change your mind, call us anytime at 817-533-8424."

PRICING:
- $99/month for 24/7 AI receptionist
- No contracts, cancel anytime
- Usually pays for itself with one captured job`;

      pendingRealtimeSessions.set(callSid, {
        callSid,
        systemPrompt,
        greeting,
        businessConfig: { id: 'outbound', name: businessName || 'AI Always Answer' },
        leadId: null,
        callId: callId || null
      });

      const connect = twiml.connect();
      const stream = connect.stream({ url: wsUrl });
      stream.parameter({ name: 'callSid', value: callSid });
    } else {
      // Half-duplex — static TwiML pitch with ElevenLabs TTS
      const halfDuplexHour = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
      const halfDuplexAfterHours = parseInt(halfDuplexHour) >= 21 || parseInt(halfDuplexHour) < 7;

      const livePitch = halfDuplexAfterHours
        ? (businessName
          ? `Hey, this is Jessica from AI Always Answer. I'm so sorry to call this late, I was expecting your voicemail. ` +
            `The fact that you answered right now? That tells me you never miss a call. But you shouldn't have to pick up at this hour to prove it. ` +
            `I'm an AI receptionist, I answer every call 24 7, so you can actually rest. ` +
            `Go get some sleep. Check out A I always answer dot com in the morning. Goodnight!`
          : `Hey, this is Jessica from AI Always Answer. So sorry to call this late, I was expecting voicemail. ` +
            `You shouldn't have to answer calls at this hour. That's literally what I do, 24 7, 99 bucks a month. ` +
            `Check out A I always answer dot com tomorrow. Get some rest!`)
        : (businessName
          ? `Oh wow, hi! This is Jessica from AI Always Answer. I'm honestly surprised someone picked up, I was calling expecting to get your voicemail. ` +
            `That actually makes my point though... did you know that 85 percent of your customers won't wait for voicemail? They just hang up and call the next company. ` +
            `I'm an AI receptionist and I can answer every call for ${businessName}, 24 7, book appointments, and capture every lead... ` +
            `and you're not going to believe this... it's 99 bucks a month. ` +
            `Can I send you a quick demo? You'll see exactly how I'd answer calls for your business.`
          : `Oh wow, hi! I'm Jessica from AI Always Answer. I was honestly expecting your voicemail. ` +
            `Did you know 85 percent of callers won't leave a voicemail? They just call your competitor instead. ` +
            `I'm an AI receptionist, 99 bucks a month, I answer every call 24 7. Can I send you a quick demo?`);
      speakText(twiml, livePitch);
      // Gather their response
      twiml.gather({
        input: 'speech',
        timeout: 5,
        speechTimeout: 'auto',
        action: `/outbound/response?id=${callId}&name=${encodeURIComponent(businessName)}`,
        method: 'POST'
      });
      twiml.pause({ length: 2 });
      speakText(twiml, `No worries! If you change your mind, call us anytime at 8 1 7, 5 3 3, 8 4 2 4. Have a great night!`);
      twiml.hangup();
    }
  } else {
    // Unknown / machine_start — AMD hasn't decided yet or detection failed.
    // DO NOT play the voicemail script — a real human might be on the line.
    // Hang up cleanly. Better to miss a voicemail than creep out a live person.
    console.log(`⚠️ AMD inconclusive (${answeredBy}) for ${businessName || 'unknown'} — hanging up clean`);
    twiml.hangup();
  }
  
  res.type('text/xml').send(twiml.toString());
});

/**
 * POST /outbound/response — Handle speech response on live calls
 */
app.post('/outbound/response', (req, res) => {
  const twiml = new VoiceResponse();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const businessName = req.query.name || '';
  
  console.log(`🗣️ Outbound live response: "${speech}" from ${businessName || 'unknown'}`);
  
  if (speech.includes('yes') || speech.includes('sure') || speech.includes('yeah') || speech.includes('okay') || speech.includes('send')) {
    speakText(twiml, 
      `Awesome! I'll send that demo right over. You'll see exactly how I'd answer calls for ${businessName || 'your business'}. ` +
      `It's already customized with your business info. Check your phone for a text with the link. ` +
      `And remember, you can call this number anytime, 8 1 7, 5 3 3, 8 4 2 4. I'm always here. Talk soon!`
    );
    twiml.hangup();

    // Fire demo drop + SMS async after TwiML response is sent
    const toPhone = req.body.To || req.body.Called || '';  // The prospect's number
    if (toPhone) {
      setImmediate(async () => {
        try {
          // 1. Generate demo slug
          const slug = generateDemoSlug(businessName, '');
          const demoUrl = `${outbound.BASE_URL}/demo/${slug}`;

          // 2. Create DB record and kick off pipeline
          db.createProspectDemo({
            slug,
            prospect_url: null,
            prospect_name: businessName,
            business_name: businessName,
            source: 'outbound_call'
          });
          runDemoDropPipeline(slug).catch(err =>
            console.error(`❌ Demo pipeline error for ${slug}:`, err)
          );

          // 3. Send SMS with demo link
          const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilioClient.messages.create({
            to: toPhone,
            from: outbound.FROM_NUMBER,
            body: `Hey! This is Jessica from AI Always Answer 👋 Here's your personalized demo — see exactly how I'd answer calls for ${businessName || 'your business'}:\n\n${demoUrl}\n\nQuestions? Call or text 817-533-8424 anytime.`
          });
          console.log(`📱 Demo SMS sent to ${toPhone} → ${demoUrl}`);
        } catch (err) {
          console.error(`❌ Demo drop / SMS failed for ${businessName}:`, err.message);
        }
      });
    } else {
      console.warn(`⚠️ No prospect phone in request body — cannot send SMS. Body keys: ${Object.keys(req.body).join(', ')}`);
    }
  } else {
    speakText(twiml,
      `No problem at all! If you ever want to see what it looks like, just call 8 1 7, 5 3 3, 8 4 2 4 anytime. ` +
      `I answer every call, even the ones your competition is missing right now. Have a great night!`
    );
    twiml.hangup();
  }
  
  res.type('text/xml').send(twiml.toString());
});

/**
 * POST /outbound/status — Track call status updates
 */
app.post('/outbound/status', (req, res) => {
  const status = req.body.CallStatus;
  const duration = req.body.CallDuration;
  const answeredBy = req.body.AnsweredBy || 'unknown';
  const prospectId = req.query.prospectId || '';
  const callId = req.query.id || '';
  const businessName = decodeURIComponent(req.query.name || '');
  
  console.log(`📊 Outbound status [${callId}]: ${status} | ${businessName || 'unknown'} | answered by: ${answeredBy} | duration: ${duration}s`);
  
  // Store call result in DB
  if (status === 'completed' || status === 'no-answer' || status === 'busy' || status === 'failed') {
    const voicemailLeft = (answeredBy.includes('machine') && parseInt(duration) > 30) ? 1 : 0;
    
    try {
      // Try insert first, update if exists (call might already be logged from a previous status event)
      const existing = db.db.prepare('SELECT id FROM outbound_calls WHERE id = ?').get(callId);
      if (existing) {
        db.db.prepare(`
          UPDATE outbound_calls SET status = ?, answered_by = ?, duration_seconds = ?, voicemail_left = ?, business_name = ?
          WHERE id = ?
        `).run(status, answeredBy, parseInt(duration) || 0, voicemailLeft, businessName, callId);
      } else {
        db.db.prepare(`
          INSERT INTO outbound_calls (id, prospect_id, phone, business_name, call_sid, status, answered_by, duration_seconds, voicemail_left, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          callId,
          prospectId || null,
          req.body.To || '',
          businessName,
          req.body.CallSid || '',
          status,
          answeredBy,
          parseInt(duration) || 0,
          voicemailLeft
        );
      }
    } catch (err) {
      console.error('❌ Failed to log outbound call:', err.message);
    }
  }
  
  res.sendStatus(200);
});

/**
 * POST /outbound/recording — Handle recording status (stores recording URL)
 */
app.post('/outbound/recording', (req, res) => {
  const callId = req.query.id || '';
  const recordingUrl = req.body.RecordingUrl || '';
  const recordingSid = req.body.RecordingSid || '';
  
  if (callId && recordingUrl) {
    console.log(`🎙️ Recording ready [${callId}]: ${recordingUrl}`);
    try {
      db.db.prepare(`UPDATE outbound_calls SET recording_url = ?, notes = COALESCE(notes, '') || ' | recording:' || ? WHERE id = ?`)
        .run(`${recordingUrl}.mp3`, `${recordingUrl}.mp3`, callId);
    } catch (err) {
      console.error('❌ Failed to save recording URL:', err.message);
    }
  }
  
  res.sendStatus(200);
});

/**
 * POST /api/outbound/test-script — Call a number with a specific industry script for testing/iteration.
 * Body: { phone, industry, businessName?, mode? }
 * mode: "pickup" (default) — forceVm so you hear script when you answer
 *        "voicemail" — normal AMD, waits for beep, tests real VM delivery
 * Example: { "phone": "8175551234", "industry": "plumber", "businessName": "Test Plumbing", "mode": "voicemail" }
 */
app.post('/api/outbound/test-script', async (req, res) => {
  const { phone, industry, businessName, mode } = req.body;

  if (!phone) return res.status(400).json({ error: 'phone is required' });
  if (!industry) return res.status(400).json({ error: 'industry is required (plumber, hvac, garage_door, septic, electrician, roofer, dental, legal, etc.)' });

  const testMode = mode || 'pickup'; // "pickup" = forceVm, "voicemail" = real AMD
  let normalized = phone.replace(/[^\d+]/g, '');
  if (!normalized.startsWith('+')) normalized = '+1' + normalized;

  const testBizName = businessName || `Test ${industry.charAt(0).toUpperCase() + industry.slice(1)} Co`;

  const script = outbound.getVoicemailScript(testBizName);
  console.log(`🧪 Test script call → ${normalized} | industry: ${industry} | biz: ${testBizName} | mode: ${testMode}`);
  console.log(`📝 Script preview: ${script.substring(0, 120)}...`);

  const forceVm = testMode === 'pickup' ? '1' : '0';
  const callId = require('uuid').v4();
  try {
    const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const call = await twilioClient.calls.create({
      to: normalized,
      from: outbound.FROM_NUMBER,
      url: `${outbound.BASE_URL}/outbound/voicemail-handler?id=${callId}&name=${encodeURIComponent(testBizName)}&phone=${encodeURIComponent(normalized)}&forceVm=${forceVm}`,
      statusCallback: `${outbound.BASE_URL}/outbound/status?id=${callId}&name=${encodeURIComponent(testBizName)}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: true,
      recordingStatusCallback: `${outbound.BASE_URL}/outbound/recording?id=${callId}`,
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 60,
      machineDetectionSpeechThreshold: 3500,
      machineDetectionSpeechEndThreshold: 3500,
      machineDetectionSilenceTimeout: 6000,
      timeout: 35,
    });

    res.json({ status: 'calling', callSid: call.sid, industry, businessName: testBizName, phone: normalized, mode: testMode });
  } catch (err) {
    console.error(`❌ Test call failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/outbound/call — Trigger a single outbound call
 */
app.post('/api/outbound/call', async (req, res) => {
  const { phone, businessName, prospectId } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'phone is required' });
  }
  
  // Normalize phone
  let normalized = phone.replace(/[^\d+]/g, '');
  if (!normalized.startsWith('+')) normalized = '+1' + normalized;
  
  const result = await outbound.callProspect({ phone: normalized, businessName, prospectId });
  res.json(result);
});

/**
 * POST /api/outbound/batch — Trigger batch outbound calls
 * Body: { prospects: [{phone, businessName, prospectId}], delayMs?: 5000 }
 */
app.post('/api/outbound/batch', async (req, res) => {
  const { prospects, delayMs } = req.body;
  
  if (!prospects || !Array.isArray(prospects) || prospects.length === 0) {
    return res.status(400).json({ error: 'prospects array is required' });
  }
  
  if (prospects.length > 50) {
    return res.status(400).json({ error: 'max 50 calls per batch' });
  }
  
  // Normalize all phones
  const normalized = prospects.map(p => ({
    ...p,
    phone: p.phone.replace(/[^\d+]/g, '').startsWith('+') ? p.phone.replace(/[^\d+]/g, '') : '+1' + p.phone.replace(/[^\d+]/g, '')
  }));
  
  // Kick off async — return immediately
  res.json({ 
    status: 'started', 
    count: normalized.length,
    message: `Calling ${normalized.length} prospects. Check /api/outbound/log for results.`
  });
  
  // Run calls in background
  outbound.batchCall(normalized, delayMs || 5000).then(results => {
    console.log(`✅ Batch complete: ${results.filter(r => r.status === 'initiated').length}/${results.length} calls initiated`);
  }).catch(err => {
    console.error('❌ Batch call error:', err.message);
  });
});

/**
 * GET /api/outbound/log — Get outbound call log
 */
app.get('/api/outbound/log', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const calls = db.db.prepare(`
      SELECT * FROM outbound_calls ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    res.json(calls);
  } catch (err) {
    res.json([]);
  }
});

/**
 * GET /api/outbound/analytics — Full campaign analytics
 */
app.get('/api/outbound/analytics', (req, res) => {
  try {
    const all = db.db.prepare('SELECT * FROM outbound_calls ORDER BY created_at DESC').all();
    
    const total = all.length;
    const voicemails = all.filter(c => (c.answered_by || '').includes('machine') && c.duration_seconds > 30);
    const humans = all.filter(c => c.answered_by === 'human');
    const noAnswer = all.filter(c => c.status === 'no-answer');
    const busy = all.filter(c => c.status === 'busy');
    const failed = all.filter(c => c.status === 'failed');
    const callbacks = all.filter(c => c.callback_received === 1);
    const recordings = all.filter(c => c.notes && c.notes.includes('recording:'));
    
    const fullScript = voicemails.filter(c => c.duration_seconds >= 85);
    const engagedHumans = humans.filter(c => c.duration_seconds >= 30);
    
    const avgVmDuration = voicemails.length > 0 
      ? Math.round(voicemails.reduce((s, c) => s + c.duration_seconds, 0) / voicemails.length) 
      : 0;
    const avgHumanDuration = humans.length > 0 
      ? Math.round(humans.reduce((s, c) => s + c.duration_seconds, 0) / humans.length) 
      : 0;
    
    res.json({
      summary: {
        totalCalls: total,
        voicemailsLeft: voicemails.length,
        voicemailRate: total > 0 ? Math.round(voicemails.length / total * 100) : 0,
        fullScriptDelivered: fullScript.length,
        fullScriptRate: voicemails.length > 0 ? Math.round(fullScript.length / voicemails.length * 100) : 0,
        humansAnswered: humans.length,
        humanRate: total > 0 ? Math.round(humans.length / total * 100) : 0,
        engagedHumans: engagedHumans.length,
        noAnswer: noAnswer.length,
        busy: busy.length,
        failed: failed.length,
        callbacks: callbacks.length,
        callbackRate: voicemails.length > 0 ? Math.round(callbacks.length / (voicemails.length + humans.length) * 100) : 0,
        avgVoicemailDuration: avgVmDuration,
        avgHumanDuration: avgHumanDuration,
        recordingsAvailable: recordings.length
      },
      humanCalls: humans.map(c => ({
        phone: c.phone,
        businessName: c.business_name,
        duration: c.duration_seconds,
        recording: c.notes && c.notes.includes('recording:') ? c.notes.split('recording:')[1].split(' |')[0] : null,
        callback: c.callback_received === 1,
        date: c.created_at
      })).sort((a, b) => b.duration - a.duration),
      callbacks: callbacks.map(c => ({
        phone: c.phone,
        businessName: c.business_name,
        originalCallDuration: c.duration_seconds,
        answeredBy: c.answered_by,
        notes: c.notes,
        date: c.created_at
      })),
      voicemails: voicemails.map(c => ({
        phone: c.phone,
        businessName: c.business_name,
        duration: c.duration_seconds,
        fullScript: c.duration_seconds >= 85,
        recording: c.notes && c.notes.includes('recording:') ? c.notes.split('recording:')[1].split(' |')[0] : null,
        date: c.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DEMO DROP ENDPOINTS ====================

// Store chat sessions in memory (sessionId → message history)
const demoChatSessions = new Map();

/**
 * Generate a URL-safe slug from business name + location
 */
function generateDemoSlug(businessName, location) {
  const base = `${businessName || 'demo'} ${location || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 40);
  const suffix = uuidv4().substring(0, 6);
  return `${base}-${suffix}`;
}

/**
 * Run the full Demo Drop pipeline (async, called after immediate response)
 */
async function runDemoDropPipeline(slug) {
  const demo = db.getProspectDemoBySlug(slug);
  if (!demo) return;

  try {
    // Step 1: Scrape
    db.updateProspectDemo(slug, { scrape_status: 'scraping' });
    let scrapedData;
    try {
      scrapedData = await scrapeSite(demo.prospect_url);
      db.updateProspectDemo(slug, {
        scrape_status: 'scraped',
        scraped_data: JSON.stringify(scrapedData)
      });
    } catch (err) {
      console.error(`❌ Scrape failed for ${slug}:`, err.message);
      db.updateProspectDemo(slug, { scrape_status: 'failed' });
      // Continue with minimal data
      scrapedData = {
        title: demo.business_name,
        metaDesc: '',
        ogSiteName: '',
        headings: [],
        navItems: [],
        phones: [],
        hours: null,
        hasEmergency: false,
        combinedText: `Business: ${demo.business_name}. Website: ${demo.prospect_url}`
      };
    }

    // Step 2: AI extraction
    db.updateProspectDemo(slug, { generate_status: 'generating' });

    let extracted;
    try {
      extracted = await aiService.extractBusinessData(scrapedData);
    } catch (err) {
      console.error(`❌ AI extraction failed for ${slug}:`, err.message);
      extracted = {
        business_name: demo.business_name || scrapedData.title || 'Business',
        business_type: 'Other',
        phone: (scrapedData.phones || [])[0] || '',
        location: '',
        services: [],
        hours: scrapedData.hours || '',
        tagline: scrapedData.metaDesc || '',
        has_emergency: scrapedData.hasEmergency || false
      };
    }

    // Update with extracted data
    db.updateProspectDemo(slug, {
      business_name: extracted.business_name || demo.business_name,
      business_type: extracted.business_type || 'Other',
      phone: extracted.phone || '',
      location: extracted.location || '',
      services: JSON.stringify(extracted.services || []),
      hours: extracted.hours || '',
      tagline: extracted.tagline || '',
      service_area: extracted.service_area || '',
      has_emergency: extracted.has_emergency ? 'true' : 'false',
      logo_url: scrapedData.logoUrl || '',
      brand_color: scrapedData.brandColor || '#2563eb'
    });

    // Step 3: Generate demo content
    let demoContent;
    try {
      demoContent = await aiService.generateDemoContent(extracted);
    } catch (err) {
      console.error(`❌ Demo content generation failed for ${slug}:`, err.message);
      demoContent = {
        demo_headline: `${extracted.business_name} Never Misses a Call — Now`,
        demo_subheadline: `Your AI receptionist answers every call, captures details, and texts you instantly.`,
        pain_points: ['Missed calls going to voicemail', 'Lost revenue from unanswered phones', 'No after-hours coverage'],
        value_props: [
          { icon: 'phone_in_talk', title: '24/7 Call Handling', desc: 'Every call answered, every time.' },
          { icon: 'schedule', title: 'After-Hours Coverage', desc: 'Nights, weekends, holidays — covered.' },
          { icon: 'location_on', title: 'Service Area Aware', desc: 'Knows your coverage area and filters calls.' },
          { icon: 'trending_up', title: 'Lead Capture', desc: 'Collects caller info and sends it to you instantly.' }
        ],
        faqs: [
          { q: `Will it know about ${extracted.business_name}?`, a: 'Yes — it is trained on your specific services and business details.' },
          { q: 'How quickly can I launch?', a: 'Most businesses are live within 24 hours of signing up.' },
          { q: 'Can I use my existing number?', a: 'Yes. Just forward calls to us — no number change needed.' },
          { q: 'What does it cost?', a: '$99/month for 500 minutes of AI receptionist coverage.' }
        ],
        system_prompt: `You are an AI receptionist for ${extracted.business_name}${extracted.business_type ? ', a ' + extracted.business_type + ' company' : ''}${extracted.location ? ' in ' + extracted.location : ''}.\n\nYOUR KNOWLEDGE:\n- Services: ${(extracted.services || []).join(', ') || 'General services'}\n- Service area: ${extracted.service_area || extracted.location || 'Local area'}\n- Hours: ${extracted.hours || 'Business hours'}\n- Phone: ${extracted.phone || 'Available on website'}\n\nYOUR GOAL: Show this business owner what their AI receptionist would sound like. Answer questions like a real receptionist would. Be warm, professional, and helpful. When they seem engaged, tell them: "This is what every caller would experience — and you can launch this for $99/month."\n\nIMPORTANT: This is a DEMO. If someone asks to actually book an appointment or schedule service, say "In the live version, I would book that for you right now. I am just showing you the experience today."\n\nKeep responses conversational and under 3 sentences unless more detail is needed.`
      };
    }

    db.updateProspectDemo(slug, {
      system_prompt: demoContent.system_prompt,
      demo_headline: demoContent.demo_headline,
      demo_subheadline: demoContent.demo_subheadline,
      pain_points: JSON.stringify(demoContent.pain_points),
      value_props: JSON.stringify(demoContent.value_props),
      faqs: JSON.stringify(demoContent.faqs),
      generate_status: 'done'
    });

    // Step 4: Send email if we have one
    const updatedDemo = db.getProspectDemoBySlug(slug);
    if (updatedDemo.prospect_email) {
      const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
      const demoUrl = `${baseUrl}/demo/${slug}`;
      try {
        await emailService.sendDemoLink(
          updatedDemo.prospect_email,
          updatedDemo.prospect_name,
          updatedDemo.business_name,
          demoUrl
        );
        db.updateProspectDemo(slug, { email_status: 'sent' });
      } catch (err) {
        console.error(`❌ Demo email failed for ${slug}:`, err.message);
        db.updateProspectDemo(slug, { email_status: 'failed' });
      }
    } else {
      db.updateProspectDemo(slug, { email_status: 'skipped' });
    }

    console.log(`✅ Demo Drop pipeline complete for ${slug}`);
  } catch (err) {
    console.error(`❌ Demo Drop pipeline error for ${slug}:`, err);
    db.updateProspectDemo(slug, { scrape_status: 'failed', generate_status: 'failed' });
  }
}

/**
 * POST /api/demo-drop — Kick off the Demo Drop pipeline
 */
app.post('/api/demo-drop', async (req, res) => {
  try {
    const { url, email, name } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL format
    let normalizedUrl = url;
    if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;
    try { new URL(normalizedUrl); } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Generate slug from URL hostname as initial business name
    const hostname = new URL(normalizedUrl).hostname.replace('www.', '');
    const businessName = hostname.split('.')[0].replace(/-/g, ' ');
    const slug = generateDemoSlug(businessName, '');

    // Create DB record
    const demo = db.createProspectDemo({
      slug,
      prospect_url: normalizedUrl,
      prospect_email: email || null,
      prospect_name: name || null,
      business_name: businessName
    });

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const demoUrl = `${baseUrl}/demo/${slug}`;

    // Return immediately, run pipeline async
    res.status(201).json({
      slug,
      demo_url: demoUrl,
      status: 'processing'
    });

    // Fire and forget the pipeline
    setImmediate(() => {
      runDemoDropPipeline(slug).catch(err => {
        console.error(`❌ Pipeline error for ${slug}:`, err);
      });
    });
  } catch (error) {
    console.error('Demo Drop error:', error);
    res.status(500).json({ error: 'Failed to create demo' });
  }
});

/**
 * GET /demo/:slug — Serve the personalized demo page
 */
app.get('/demo/:slug', (req, res) => {
  const { slug } = req.params;
  const demo = db.getProspectDemoBySlug(slug);

  if (!demo) {
    return res.status(404).send('<h1>Demo not found</h1><p>This demo link is invalid or has expired.</p>');
  }

  // Increment view count
  db.incrementDemoView(slug);

  // Parse JSON fields safely
  const services = JSON.parse(demo.services || '[]');
  const painPoints = JSON.parse(demo.pain_points || '[]');
  const valueProps = JSON.parse(demo.value_props || '[]');
  const faqs = JSON.parse(demo.faqs || '[]');
  const brandColor = demo.brand_color || '#2563eb';

  // Check if still processing
  const isReady = demo.generate_status === 'done';

  res.send(`<!DOCTYPE html>
<html class="scroll-smooth dark" lang="en">
<head>
    <meta charset="utf-8"/>
    <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
    <title>${demo.business_name} AI Receptionist Demo | AI Always Answer</title>
    <meta name="description" content="${demo.demo_subheadline || 'Your personalized AI receptionist demo'}"/>
    <link href="https://fonts.googleapis.com" rel="preconnect"/>
    <link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect"/>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet"/>
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet"/>
    <script src="https://cdn.tailwindcss.com?plugins=forms,typography"></script>
    <script>
      tailwind.config = {
        darkMode: "class",
        theme: {
          extend: {
            colors: {
              primary: "${brandColor}",
              "background-dark": "#0f172a",
              "surface-dark": "#1e293b",
              "accent-neon": "#38bdf8"
            },
            fontFamily: {
              display: ["Plus Jakarta Sans", "sans-serif"],
              sans: ["Inter", "sans-serif"]
            }
          }
        }
      };
    </script>
    <style>
      .glass-card { background: rgba(15, 23, 42, 0.72); backdrop-filter: blur(18px); border: 1px solid rgba(148, 163, 184, 0.18); }
      .mesh-bg {
        background:
          radial-gradient(circle at top left, rgba(37, 99, 235, 0.28), transparent 32%),
          radial-gradient(circle at bottom right, rgba(56, 189, 248, 0.22), transparent 28%),
          linear-gradient(135deg, #020617 0%, #0f172a 48%, #111827 100%);
      }
      details summary::-webkit-details-marker { display: none; }
      #chat-messages { scrollbar-width: thin; scrollbar-color: #334155 transparent; }
      #chat-messages::-webkit-scrollbar { width: 6px; }
      #chat-messages::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      .chat-msg-ai { background: rgba(37, 99, 235, 0.15); border: 1px solid rgba(37, 99, 235, 0.25); }
      .chat-msg-user { background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.2); }
      .typing-dot { animation: blink 1.4s infinite both; }
      .typing-dot:nth-child(2) { animation-delay: 0.2s; }
      .typing-dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
    </style>
</head>
<body class="bg-background-dark text-slate-100 font-sans">

${!isReady ? `
<div class="fixed inset-0 z-50 flex items-center justify-center bg-background-dark/95">
  <div class="text-center p-8">
    <div class="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-primary/20 mb-6">
      <span class="material-symbols-outlined text-3xl text-primary animate-spin">sync</span>
    </div>
    <h2 class="font-display text-2xl font-bold mb-3">Building Your Demo...</h2>
    <p class="text-slate-400 mb-6">We're scraping your website and training your AI receptionist. This usually takes 30-60 seconds.</p>
    <p class="text-sm text-slate-500">This page will auto-refresh when ready.</p>
  </div>
</div>
<script>setTimeout(() => location.reload(), 8000);</script>
` : ''}

<header class="mesh-bg relative overflow-hidden px-4 pb-24 pt-8 text-white">
    <div class="absolute left-0 top-0 h-full w-full opacity-40">
        <div class="absolute left-[-10%] top-[-12%] h-72 w-72 rounded-full bg-primary blur-[120px]"></div>
        <div class="absolute bottom-[-14%] right-[-6%] h-80 w-80 rounded-full bg-accent-neon blur-[140px]"></div>
    </div>
    <nav class="relative z-10 mx-auto flex max-w-7xl items-center justify-between py-4">
        <div class="flex items-center space-x-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary shadow-lg shadow-blue-500/20">
                <span class="material-symbols-outlined text-xl text-white">smart_toy</span>
            </div>
            <div>
                <span class="block font-display text-xl font-bold tracking-tight">${demo.business_name}</span>
                <span class="block text-xs font-medium uppercase tracking-[0.24em] text-slate-400">AI Receptionist Demo</span>
            </div>
        </div>
        <a class="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-950 transition-all hover:scale-[1.03]" href="#cta">
            Get Started — $99/mo
        </a>
    </nav>

    <div class="relative z-10 mx-auto mt-12 grid max-w-7xl gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div>
            <div class="mb-6 inline-flex items-center rounded-full border border-blue-400/30 bg-blue-500/10 px-4 py-1.5 text-sm font-semibold text-accent-neon">
                ${demo.business_type ? `Built for ${demo.business_type} businesses` : 'Your personalized AI demo'}
            </div>
            <h1 class="max-w-4xl font-display text-5xl font-extrabold leading-[1.02] tracking-tight md:text-6xl">
                ${demo.demo_headline || demo.business_name + ' Never Misses a Call — Now'}
            </h1>
            <p class="mt-6 max-w-2xl text-lg leading-relaxed text-slate-300 md:text-xl">
                ${demo.demo_subheadline || 'Your AI receptionist answers every call, captures details, and texts you instantly.'}
            </p>
            <div class="mt-10 flex flex-col gap-4 sm:flex-row">
                <a class="inline-flex items-center justify-center rounded-2xl bg-primary px-8 py-4 text-lg font-bold text-white shadow-lg shadow-blue-500/25 transition-all hover:-translate-y-0.5 hover:bg-blue-700" href="#chat-section">
                    Try the Live Chat Demo
                </a>
                <a class="inline-flex items-center justify-center rounded-2xl border border-slate-600 bg-white/5 px-8 py-4 text-lg font-semibold text-white transition-colors hover:border-slate-400 hover:bg-white/10" href="#cta">
                    Start for $99/mo
                </a>
            </div>
            ${services.length > 0 ? `
            <div class="mt-8 flex flex-wrap gap-3 text-sm font-medium text-slate-300">
                ${services.slice(0, 5).map(s => `<span class="rounded-full border border-slate-700 bg-slate-900/50 px-4 py-2">${s}</span>`).join('')}
            </div>` : ''}
        </div>

        <!-- LIVE CHAT WIDGET -->
        <div class="glass-card rounded-[2rem] p-6 shadow-2xl shadow-slate-950/30" id="chat-section">
            <div class="mb-4 flex items-center justify-between">
                <div class="inline-flex items-center rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-emerald-300">
                    <span class="mr-2 h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    Live Demo
                </div>
                <span class="text-xs text-slate-500">Powered by AI Always Answer</span>
            </div>
            <div id="chat-messages" class="h-80 overflow-y-auto space-y-3 mb-4 pr-1">
                <div class="chat-msg-ai rounded-2xl rounded-tl-md px-4 py-3 max-w-[85%]">
                    <p class="text-sm text-slate-200">Hi! Thanks for calling ${demo.business_name}. How can I help you today?</p>
                </div>
            </div>
            <form id="chat-form" class="flex gap-2">
                <input type="text" id="chat-input" placeholder="Type a message..." autocomplete="off"
                    class="flex-1 rounded-xl border-slate-700 bg-slate-900/80 px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-primary focus:ring-primary" />
                <button type="submit" class="rounded-xl bg-primary px-4 py-3 text-white transition-colors hover:bg-blue-700">
                    <span class="material-symbols-outlined text-lg">send</span>
                </button>
            </form>
        </div>
    </div>
</header>

${painPoints.length > 0 ? `
<section class="bg-[#0b1220] px-4 py-24">
    <div class="mx-auto max-w-6xl">
        <div class="mx-auto max-w-3xl text-center">
            <h2 class="font-display text-4xl font-bold tracking-tight text-white">Sound familiar?</h2>
            <p class="mt-4 text-lg leading-relaxed text-slate-400">
                These are the problems ${demo.business_name} faces every day with missed calls.
            </p>
        </div>
        <div class="mt-14 grid gap-8 md:grid-cols-${Math.min(painPoints.length, 3)}">
            ${painPoints.map(pp => `
            <div class="rounded-[1.75rem] border border-slate-800 bg-surface-dark p-8 text-center shadow-sm">
                <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10">
                    <span class="material-symbols-outlined text-3xl text-red-500">phone_missed</span>
                </div>
                <p class="mt-6 text-lg leading-relaxed text-slate-300">${pp}</p>
            </div>`).join('')}
        </div>
    </div>
</section>` : ''}

${valueProps.length > 0 ? `
<section class="bg-background-dark/50 px-4 py-24">
    <div class="mx-auto max-w-6xl">
        <div class="mx-auto max-w-3xl text-center">
            <h2 class="font-display text-4xl font-bold tracking-tight text-white">What your AI receptionist does for ${demo.business_name}.</h2>
        </div>
        <div class="mt-14 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            ${valueProps.map(vp => `
            <div class="group rounded-[1.75rem] border border-slate-800 bg-surface-dark p-8 shadow-sm transition-shadow hover:shadow-xl">
                <div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/10 transition-colors group-hover:bg-primary">
                    <span class="material-symbols-outlined text-3xl text-primary group-hover:text-white">${vp.icon || 'star'}</span>
                </div>
                <h3 class="mt-6 font-display text-xl font-bold text-white">${vp.title}</h3>
                <p class="mt-3 leading-relaxed text-slate-400">${vp.desc}</p>
            </div>`).join('')}
        </div>
    </div>
</section>` : ''}

${faqs.length > 0 ? `
<section class="bg-[#0b1220] px-4 py-24">
    <div class="mx-auto max-w-4xl">
        <div class="mx-auto max-w-3xl text-center">
            <h2 class="font-display text-4xl font-bold tracking-tight text-white">Frequently Asked Questions</h2>
        </div>
        <div class="mt-12 space-y-4">
            ${faqs.map((faq, i) => `
            <details class="group rounded-[1.5rem] border border-slate-800 bg-surface-dark p-6 shadow-sm open:border-primary/30 open:shadow-lg"${i === 0 ? ' open' : ''}>
                <summary class="flex cursor-pointer list-none items-center justify-between gap-6 font-display text-xl font-bold text-white">
                    ${faq.q}
                    <span class="material-symbols-outlined text-slate-400 transition-transform group-open:rotate-45">add</span>
                </summary>
                <p class="mt-4 text-base leading-relaxed text-slate-400">${faq.a}</p>
            </details>`).join('')}
        </div>
    </div>
</section>` : ''}

<section class="mesh-bg relative px-4 py-28 text-white" id="cta">
    <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.18),_transparent_32%)]"></div>
    <div class="relative mx-auto max-w-3xl text-center">
        <h2 class="font-display text-4xl font-bold tracking-tight md:text-5xl">
            Launch this exact setup for ${demo.business_name}.
        </h2>
        <p class="mt-6 text-lg leading-relaxed text-slate-300">
            Everything you just saw — the AI receptionist trained on your business, 24/7 call handling, instant lead alerts — starts at $99/month.
        </p>
        <div class="mt-10 flex flex-col items-center gap-6">
            <a href="https://buy.stripe.com/dRm4gzdiF6aqcykcfZ18c07" class="inline-flex items-center justify-center rounded-2xl bg-primary px-10 py-5 text-xl font-bold text-white shadow-lg shadow-blue-500/25 transition-all hover:-translate-y-0.5 hover:bg-blue-700">
                Start for $99/mo
            </a>
            <div class="grid grid-cols-3 gap-8 mt-4">
                <div class="text-center">
                    <div class="font-display text-3xl font-extrabold">24/7</div>
                    <div class="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">Coverage</div>
                </div>
                <div class="text-center">
                    <div class="font-display text-3xl font-extrabold">500</div>
                    <div class="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">Minutes</div>
                </div>
                <div class="text-center">
                    <div class="font-display text-3xl font-extrabold">$99</div>
                    <div class="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">/month</div>
                </div>
            </div>
        </div>

        <!-- Lead capture form -->
        <div class="mt-12 mx-auto max-w-md rounded-[2rem] border border-slate-700/70 bg-slate-950/45 p-8 text-left">
            <h3 class="font-display text-xl font-bold text-white mb-4">Want us to set this up for you?</h3>
            <form id="lead-form" class="space-y-4">
                <input type="text" name="name" placeholder="Your name" class="w-full rounded-xl border-slate-700 bg-slate-900/80 px-4 py-3 text-white focus:border-primary focus:ring-primary" />
                <input type="email" name="email" placeholder="Email address" required class="w-full rounded-xl border-slate-700 bg-slate-900/80 px-4 py-3 text-white focus:border-primary focus:ring-primary" />
                <input type="tel" name="phone" placeholder="Phone number" required class="w-full rounded-xl border-slate-700 bg-slate-900/80 px-4 py-3 text-white focus:border-primary focus:ring-primary" />
                <button type="submit" class="w-full rounded-2xl bg-accent-neon py-4 text-lg font-bold text-slate-950 transition-all hover:bg-sky-300">
                    Get My AI Receptionist
                </button>
                <div id="lead-success" class="hidden rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100"></div>
            </form>
        </div>
    </div>
</section>

<footer class="border-t border-slate-800 bg-background-dark px-4 py-12">
    <div class="mx-auto max-w-6xl text-center">
        <div class="flex items-center justify-center space-x-3 mb-4">
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                <span class="material-symbols-outlined text-sm text-white">smart_toy</span>
            </div>
            <span class="font-display text-lg font-bold">AI Always Answer</span>
        </div>
        <p class="text-sm text-slate-500">&copy; 2026 AI Always Answer. All rights reserved.</p>
    </div>
</footer>

<script>
(function() {
  const SLUG = '${slug}';
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatMessages = document.getElementById('chat-messages');
  let sessionId = 'sess-' + Math.random().toString(36).substring(2, 10);
  let chatStarted = false;

  function addMessage(text, role) {
    const div = document.createElement('div');
    div.className = role === 'user'
      ? 'chat-msg-user rounded-2xl rounded-tr-md px-4 py-3 max-w-[85%] ml-auto'
      : 'chat-msg-ai rounded-2xl rounded-tl-md px-4 py-3 max-w-[85%]';
    div.innerHTML = '<p class="text-sm text-slate-200">' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.id = 'typing-indicator';
    div.className = 'chat-msg-ai rounded-2xl rounded-tl-md px-4 py-3 max-w-[85%]';
    div.innerHTML = '<div class="flex gap-1"><span class="typing-dot h-2 w-2 rounded-full bg-slate-400 inline-block"></span><span class="typing-dot h-2 w-2 rounded-full bg-slate-400 inline-block"></span><span class="typing-dot h-2 w-2 rounded-full bg-slate-400 inline-block"></span></div>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  chatForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    addMessage(msg, 'user');
    chatInput.value = '';
    chatInput.disabled = true;
    showTyping();

    try {
      const res = await fetch('/api/demo/' + SLUG + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, sessionId: sessionId })
      });
      const data = await res.json();
      hideTyping();
      if (data.reply) {
        addMessage(data.reply, 'ai');
      } else {
        addMessage('Sorry, I had a moment. Could you try again?', 'ai');
      }
    } catch (err) {
      hideTyping();
      addMessage('Connection error. Please try again.', 'ai');
    }

    chatInput.disabled = false;
    chatInput.focus();
  });

  // Lead capture form
  const leadForm = document.getElementById('lead-form');
  if (leadForm) {
    leadForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());
      data.company = '${demo.business_name.replace(/'/g, "\\'")}';
      data.source = 'demo_drop';
      data.formType = 'demo_drop_lead';
      data.pageVariant = 'demo-' + SLUG;

      try {
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) {
          document.getElementById('lead-success').textContent = 'Got it! We will reach out within 24 hours to get you set up.';
          document.getElementById('lead-success').classList.remove('hidden');
          e.target.reset();

          // Track lead captured
          fetch('/api/demo-drop/' + SLUG + '/status', { method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead_captured: 1 })
          }).catch(function(){});
        }
      } catch (err) {
        document.getElementById('lead-success').textContent = 'Something went wrong. Please try again.';
        document.getElementById('lead-success').classList.remove('hidden');
      }
    });
  }
})();
</script>
</body>
</html>`);
});

/**
 * POST /api/demo/:slug/chat — Chat with the demo AI
 */
app.post('/api/demo/:slug/chat', async (req, res) => {
  try {
    const { slug } = req.params;
    const { message, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const demo = db.getProspectDemoBySlug(slug);
    if (!demo || demo.generate_status !== 'done') {
      return res.status(404).json({ error: 'Demo not found or still processing' });
    }

    // Mark chat as started
    if (!demo.chat_started) {
      db.updateProspectDemo(slug, { chat_started: 1 });
    }

    // Get or create session history
    const sessKey = `${slug}:${sessionId || 'default'}`;
    if (!demoChatSessions.has(sessKey)) {
      demoChatSessions.set(sessKey, []);
    }
    const history = demoChatSessions.get(sessKey);

    // Add user message
    history.push({ role: 'user', content: message });

    // Get AI response using the demo's system prompt
    const reply = await aiService.getResponse(history, message, demo.system_prompt);

    // Add AI response to history
    history.push({ role: 'assistant', content: reply });

    // Cap history at 30 messages
    if (history.length > 30) {
      demoChatSessions.set(sessKey, history.slice(-20));
    }

    res.json({ reply });
  } catch (error) {
    console.error('Demo chat error:', error);
    res.status(500).json({ error: 'Chat error', reply: 'Sorry, I had a hiccup. Try again?' });
  }
});

/**
 * GET /api/demo-drop/list — List all demos (dashboard)
 */
app.get('/api/demo-drop/list', (req, res) => {
  const demos = db.getProspectDemos(parseInt(req.query.limit) || 100);
  res.json(demos.map(d => ({
    slug: d.slug,
    business_name: d.business_name,
    business_type: d.business_type,
    prospect_email: d.prospect_email,
    prospect_url: d.prospect_url,
    demo_url: `${process.env.BASE_URL || 'https://aialwaysanswer.com'}/demo/${d.slug}`,
    scrape_status: d.scrape_status,
    generate_status: d.generate_status,
    email_status: d.email_status,
    view_count: d.view_count,
    chat_started: d.chat_started,
    lead_captured: d.lead_captured,
    converted: d.converted,
    created_at: d.created_at
  })));
});

/**
 * GET /api/demo-drop/:slug/status — Check demo status
 */
app.get('/api/demo-drop/:slug/status', (req, res) => {
  const demo = db.getProspectDemoBySlug(req.params.slug);
  if (!demo) return res.status(404).json({ error: 'Demo not found' });

  res.json({
    slug: demo.slug,
    business_name: demo.business_name,
    scrape_status: demo.scrape_status,
    generate_status: demo.generate_status,
    email_status: demo.email_status,
    view_count: demo.view_count,
    chat_started: demo.chat_started,
    lead_captured: demo.lead_captured,
    converted: demo.converted,
    created_at: demo.created_at,
    updated_at: demo.updated_at
  });
});

/**
 * PATCH /api/demo-drop/:slug/status — Update demo tracking fields
 */
app.patch('/api/demo-drop/:slug/status', (req, res) => {
  const demo = db.getProspectDemoBySlug(req.params.slug);
  if (!demo) return res.status(404).json({ error: 'Demo not found' });

  const allowed = ['lead_captured', 'converted', 'chat_started'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length > 0) {
    db.updateProspectDemo(req.params.slug, updates);
  }

  res.json({ success: true });
});

// ==================== CUSTOMER PORTAL (/my/*) ====================

/**
 * Middleware: validate customer auth token from cookie or query param
 */
function validateCustomerToken(req, res, next) {
  const token = req.cookies?.aaa_token || req.query.token;
  if (!token) {
    return res.redirect('/my/login');
  }
  const customer = db.getCustomerByToken(token);
  if (!customer) {
    return res.redirect('/my/login');
  }
  req.customer = customer;
  next();
}


/**
 * GET /my/login — Magic link login page
 */
app.get('/my/login', (req, res) => {
  const sent = req.query.sent;
  const error = req.query.error;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sign In - AI Always Answer</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .card { background: white; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 420px; width: 100%; }
        .logo { font-size: 22px; font-weight: 700; color: #2563eb; text-align: center; margin-bottom: 8px; }
        .subtitle { text-align: center; color: #6b7280; margin-bottom: 32px; font-size: 15px; }
        label { display: block; font-weight: 600; color: #374151; margin-bottom: 6px; font-size: 14px; }
        input { width: 100%; padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 16px; margin-bottom: 20px; }
        input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
        button { width: 100%; padding: 14px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }
        button:hover { background: #1d4ed8; }
        button:disabled { background: #9ca3af; cursor: not-allowed; }
        .msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; }
        .msg-success { background: #d1fae5; color: #065f46; }
        .msg-error { background: #fee2e2; color: #991b1b; }
        .footer { text-align: center; margin-top: 24px; color: #9ca3af; font-size: 13px; }
        .footer a { color: #2563eb; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">AI Always Answer</div>
        <div class="subtitle">Customer Dashboard</div>
        ${sent ? '<div class="msg msg-success">Check your email for a login link.</div>' : ''}
        ${error ? '<div class="msg msg-error">No account found with that email. Please check and try again.</div>' : ''}
        <form method="POST" action="/api/my/login">
          <label for="email">Email Address</label>
          <input type="email" id="email" name="email" placeholder="you@company.com" required>
          <button type="submit">Send Login Link</button>
        </form>
        <div class="footer">
          <a href="/">Back to AI Always Answer</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

/**
 * POST /api/my/login — Send magic link email
 */
app.post('/api/my/login', async (req, res) => {
  const email = req.body.email;
  if (!email) return res.redirect('/my/login?error=1');

  const customer = db.getCustomerByEmail(email.trim().toLowerCase());
  if (!customer) return res.redirect('/my/login?error=1');

  // Regenerate token for security
  const token = db.regenerateAuthToken(customer.id);
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const loginUrl = `${baseUrl}/my/auth?token=${token}`;

  await emailService.sendMagicLink(email, loginUrl);
  res.redirect('/my/login?sent=1');
});

/**
 * GET /my/auth — Validate token from magic link, set cookie, redirect to dashboard
 */
app.get('/my/auth', (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/my/login');

  const customer = db.getCustomerByToken(token);
  if (!customer) return res.redirect('/my/login');

  // Set httpOnly cookie so they stay logged in
  res.setHeader('Set-Cookie', `aaa_token=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);

  // Redirect to onboarding if no Twilio number yet, otherwise dashboard
  if (!customer.twilio_number) {
    return res.redirect('/my/onboarding');
  }
  res.redirect('/my/dashboard');
});

/**
 * GET /my/logout — Clear cookie
 */
app.get('/my/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'aaa_token=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/my/login');
});

/**
 * GET /api/my/stats — Customer-specific stats
 */
app.get('/api/my/stats', validateCustomerToken, (req, res) => {
  const stats = db.getCustomerStats(req.customer.id);
  res.json(stats);
});

/**
 * GET /api/my/calls — Customer's call log
 */
app.get('/api/my/calls', validateCustomerToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const calls = db.getCustomerCalls(req.customer.id, limit);
  res.json(calls);
});

/**
 * GET /api/my/leads — Customer's leads
 */
app.get('/api/my/leads', validateCustomerToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const leads = db.getCustomerLeads(req.customer.id, limit);
  res.json(leads);
});

/**
 * POST /api/my/settings — Update customer business settings
 */
app.post('/api/my/settings', validateCustomerToken, (req, res) => {
  const { businessName, industry, phone, address, hours, website, greeting } = req.body;
  const currentConfig = req.customer.ai_config ? JSON.parse(req.customer.ai_config) : {};

  const updatedConfig = {
    ...currentConfig,
    businessName: businessName || currentConfig.businessName,
    industry: industry || currentConfig.industry,
    phone: phone || currentConfig.phone,
    address: address || currentConfig.address,
    hours: hours || currentConfig.hours,
    website: website || currentConfig.website,
    greeting: greeting || currentConfig.greeting
  };

  const customer = db.updateCustomerConfig(req.customer.id, updatedConfig);
  res.json({ success: true, customer });
});

/**
 * POST /api/onboarding/setup — Full onboarding: save business info, provision Twilio number, configure webhook
 */
app.post('/api/onboarding/setup', validateCustomerToken, async (req, res) => {
  try {
    const { businessName, industry, phone, address, hours, website } = req.body;
    if (!businessName) return res.status(400).json({ error: 'Business name is required' });

    const customer = req.customer;

    // 1. Save business info as ai_config
    const aiConfig = {
      businessName,
      industry: industry || '',
      phone: phone || '',
      address: address || '',
      hours: hours || '',
      website: website || '',
      greeting: `Thanks for calling ${businessName}! This is Jessica, your AI receptionist. How can I help you today?`,
      systemPrompt: generateCustomerSystemPrompt({ businessName, industry, phone, address, hours, website })
    };
    db.updateCustomerConfig(customer.id, aiConfig);

    // 2. Provision a Twilio number (if they don't already have one)
    let twilioNumber = customer.twilio_number;
    if (!twilioNumber) {
      twilioNumber = await provisionTwilioNumber(customer.id);
      if (!twilioNumber) {
        return res.status(500).json({ error: 'Failed to provision phone number. Please contact support.' });
      }
    }

    res.json({
      success: true,
      twilioNumber,
      businessName,
      message: 'Your AI receptionist is ready! Forward your calls to the number above.'
    });
  } catch (err) {
    console.error('Onboarding setup error:', err);
    res.status(500).json({ error: 'Setup failed. Please try again or contact support.' });
  }
});

/**
 * Generate a system prompt for a customer's AI receptionist based on their business info
 */
function generateCustomerSystemPrompt(info) {
  return `You are Jessica, a friendly and professional AI phone receptionist for ${info.businessName}.

YOUR GOAL: Answer calls professionally, help callers with their questions, collect their information, and let them know someone from ${info.businessName} will follow up.

PERSONALITY:
- Warm, professional, and helpful
- Speak naturally like a real receptionist
- Be efficient — get the info you need without dragging the call out
- Keep responses to 1-3 sentences (this is a phone call)
- NEVER use emojis in your responses

BUSINESS INFO:
- Business: ${info.businessName}
${info.industry ? `- Industry: ${info.industry}` : ''}
${info.phone ? `- Business phone: ${info.phone}` : ''}
${info.address ? `- Address: ${info.address}` : ''}
${info.hours ? `- Hours: ${info.hours}` : ''}
${info.website ? `- Website: ${info.website}` : ''}

INFORMATION TO COLLECT:
1. What they need help with
2. Their name
3. Best callback number (confirm the number they're calling from or ask for a better one)
4. Best time to call back

CLOSING:
- Confirm the info you collected
- "Great, I've got all your information. Someone from ${info.businessName} will be reaching out to you shortly. Is there anything else I can help with?"
- "Thanks for calling ${info.businessName}. Have a great day!"

IMPORTANT:
- If asked about pricing, say "Pricing depends on your specific needs, but let me get your info so we can provide an accurate quote."
- If asked if you're an AI, be honest: "I'm an AI assistant helping answer calls for ${info.businessName}. I'm getting all your info to a real person who will call you right back."
- Keep it brief and professional.`;
}

/**
 * Provision a Twilio phone number for a customer
 * Tries DFW area codes (817, 682), falls back to any US number
 */
async function provisionTwilioNumber(customerId) {
  try {
    const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
    const voiceUrl = `${baseUrl}/voice/incoming-realtime`;

    // Try DFW area codes first
    const areaCodes = ['817', '682', '214', '972'];
    let purchased = null;

    for (const areaCode of areaCodes) {
      try {
        const available = await twilioClient.availablePhoneNumbers('US')
          .local.list({ areaCode, limit: 1, voiceEnabled: true });

        if (available.length > 0) {
          purchased = await twilioClient.incomingPhoneNumbers.create({
            phoneNumber: available[0].phoneNumber,
            voiceUrl,
            voiceMethod: 'POST',
            friendlyName: `Customer ${customerId}`
          });
          break;
        }
      } catch (err) {
        console.log(`No numbers in ${areaCode}, trying next...`);
      }
    }

    // Fallback: any US number
    if (!purchased) {
      const available = await twilioClient.availablePhoneNumbers('US')
        .local.list({ limit: 1, voiceEnabled: true });
      if (available.length > 0) {
        purchased = await twilioClient.incomingPhoneNumbers.create({
          phoneNumber: available[0].phoneNumber,
          voiceUrl,
          voiceMethod: 'POST',
          friendlyName: `Customer ${customerId}`
        });
      }
    }

    if (purchased) {
      db.updateCustomerTwilioNumber(customerId, purchased.phoneNumber);
      console.log(`📞 Provisioned ${purchased.phoneNumber} for customer ${customerId}`);
      return purchased.phoneNumber;
    }

    console.error('Failed to provision any Twilio number');
    return null;
  } catch (err) {
    console.error('Twilio provisioning error:', err.message);
    return null;
  }
}

/**
 * GET /my/onboarding — Multi-step onboarding wizard
 */
app.get('/my/onboarding', validateCustomerToken, (req, res) => {
  const customer = req.customer;
  const config = customer.ai_config ? JSON.parse(customer.ai_config) : {};
  const hasNumber = !!customer.twilio_number;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Set Up Your AI Receptionist - AI Always Answer</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #1f2937; }
        .header { background: white; border-bottom: 1px solid #e5e7eb; padding: 16px 24px; }
        .header-inner { max-width: 800px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
        .logo { font-size: 20px; font-weight: 700; color: #2563eb; text-decoration: none; }
        .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
        .progress { display: flex; gap: 8px; margin-bottom: 40px; }
        .progress-step { flex: 1; height: 4px; border-radius: 4px; background: #e5e7eb; transition: background 0.3s; }
        .progress-step.active { background: #2563eb; }
        .progress-step.done { background: #10b981; }
        .step { display: none; }
        .step.active { display: block; }
        .step h2 { font-size: 24px; margin-bottom: 8px; }
        .step .desc { color: #6b7280; margin-bottom: 32px; font-size: 15px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 14px; color: #374151; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 15px; font-family: inherit; }
        .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .btn { padding: 14px 28px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; border: none; transition: all 0.2s; }
        .btn-primary { background: #2563eb; color: white; }
        .btn-primary:hover { background: #1d4ed8; }
        .btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
        .btn-outline { background: white; color: #374151; border: 1px solid #d1d5db; }
        .btn-outline:hover { background: #f9fafb; }
        .btn-success { background: #10b981; color: white; }
        .btn-success:hover { background: #059669; }
        .btn-row { display: flex; justify-content: space-between; margin-top: 32px; }
        .number-display { background: #eff6ff; border: 2px solid #2563eb; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0; }
        .number-display .number { font-size: 32px; font-weight: 700; color: #2563eb; letter-spacing: 1px; }
        .number-display .label { color: #6b7280; font-size: 14px; margin-top: 4px; }
        .copy-btn { margin-top: 12px; background: #2563eb; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        .copy-btn:hover { background: #1d4ed8; }
        .copy-btn.copied { background: #10b981; }
        .instructions { background: white; border-radius: 12px; padding: 24px; margin: 24px 0; border: 1px solid #e5e7eb; }
        .instructions h3 { margin-bottom: 12px; }
        .instructions ol { padding-left: 20px; color: #4b5563; line-height: 2; }
        .forward-highlight { display: inline-block; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 2px 8px; font-family: monospace; font-size: 15px; font-weight: 700; color: #92400e; }
        .tip-box { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 12px 16px; margin-top: 16px; font-size: 14px; color: #14532d; }
        .test-area { background: #f0fdf4; border: 2px solid #10b981; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0; }
        .test-area p { color: #065f46; margin-bottom: 16px; }
        .error-msg { color: #dc2626; margin-top: 8px; font-size: 14px; display: none; }
        .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid white; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 8px; vertical-align: middle; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .footer { text-align: center; padding: 24px; color: #9ca3af; font-size: 13px; }
        @media (max-width: 640px) { .form-row { grid-template-columns: 1fr; } }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-inner">
          <a href="/my/dashboard" class="logo">AI Always Answer</a>
          <span style="color:#6b7280; font-size:14px;">${customer.email}</span>
        </div>
      </div>
      <div class="container">
        <div class="progress">
          <div class="progress-step active" id="prog-1"></div>
          <div class="progress-step" id="prog-2"></div>
          <div class="progress-step" id="prog-3"></div>
        </div>

        <!-- STEP 1: Business Info -->
        <div class="step active" id="step-1">
          <h2>Tell us about your business</h2>
          <p class="desc">We'll use this to train your AI receptionist so she sounds like she's worked for you for years.</p>
          <form id="biz-form">
            <div class="form-group">
              <label for="businessName">Business Name *</label>
              <input type="text" id="businessName" value="${config.businessName || customer.company || ''}" required placeholder="Acme Plumbing">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="industry">Industry</label>
                <select id="industry">
                  <option value="">Select industry...</option>
                  <option value="plumbing" ${config.industry === 'plumbing' ? 'selected' : ''}>Plumbing</option>
                  <option value="hvac" ${config.industry === 'hvac' ? 'selected' : ''}>HVAC</option>
                  <option value="electrical" ${config.industry === 'electrical' ? 'selected' : ''}>Electrical</option>
                  <option value="roofing" ${config.industry === 'roofing' ? 'selected' : ''}>Roofing</option>
                  <option value="landscaping" ${config.industry === 'landscaping' ? 'selected' : ''}>Landscaping</option>
                  <option value="pest-control" ${config.industry === 'pest-control' ? 'selected' : ''}>Pest Control</option>
                  <option value="cleaning" ${config.industry === 'cleaning' ? 'selected' : ''}>Cleaning</option>
                  <option value="automotive" ${config.industry === 'automotive' ? 'selected' : ''}>Automotive</option>
                  <option value="dental" ${config.industry === 'dental' ? 'selected' : ''}>Dental</option>
                  <option value="medical" ${config.industry === 'medical' ? 'selected' : ''}>Medical</option>
                  <option value="legal" ${config.industry === 'legal' ? 'selected' : ''}>Legal</option>
                  <option value="real-estate" ${config.industry === 'real-estate' ? 'selected' : ''}>Real Estate</option>
                  <option value="restaurant" ${config.industry === 'restaurant' ? 'selected' : ''}>Restaurant</option>
                  <option value="salon" ${config.industry === 'salon' ? 'selected' : ''}>Salon / Spa</option>
                  <option value="construction" ${config.industry === 'construction' ? 'selected' : ''}>Construction</option>
                  <option value="other" ${config.industry === 'other' ? 'selected' : ''}>Other</option>
                </select>
              </div>
              <div class="form-group">
                <label for="phone">Business Phone</label>
                <input type="tel" id="phone" value="${config.phone || customer.phone || ''}" placeholder="(817) 555-1234">
              </div>
            </div>
            <div class="form-group">
              <label for="address">Business Address / Service Area</label>
              <input type="text" id="address" value="${config.address || ''}" placeholder="Fort Worth, TX / DFW Metroplex">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="hours">Business Hours</label>
                <input type="text" id="hours" value="${config.hours || ''}" placeholder="Mon-Fri 8am-6pm">
              </div>
              <div class="form-group">
                <label for="website">Website</label>
                <input type="url" id="website" value="${config.website || ''}" placeholder="https://yourbusiness.com">
              </div>
            </div>
            <div class="btn-row">
              <div></div>
              <button type="submit" class="btn btn-primary">Continue</button>
            </div>
          </form>
        </div>

        <!-- STEP 2: Review & Confirm -->
        <div class="step" id="step-2">
          <h2>Your AI receptionist is ready! 🎉</h2>
          <p class="desc">Here's your dedicated number. Forward your calls here and Jessica answers anything you miss.</p>
          <div id="setup-loading" style="text-align:center; padding: 40px;">
            <div class="spinner" style="width:40px; height:40px; border-width:3px; border-color:#2563eb; border-top-color:transparent;"></div>
            <p style="margin-top:16px; color:#6b7280;">Provisioning your phone number...</p>
          </div>
          <div id="setup-result" style="display:none;">
            <div class="number-display">
              <div class="label">Your AI Receptionist Number</div>
              <div class="number" id="provisioned-number"></div>
              <button class="copy-btn" id="copy-number-btn" onclick="copyNumber()">📋 Copy Number</button>
            </div>
            <div class="instructions">
              <h3>📲 How to forward your calls here:</h3>
              <ol>
                <li>
                  <strong>Forward on no-answer (recommended)</strong> — Your phone rings first, then Jessica catches it if you don't pick up.<br>
                  <span style="color:#6b7280; font-size:14px;">On most landlines/cell: dial <span class="forward-highlight">*61 + your AI number</span> then press call</span>
                </li>
                <li>
                  <strong>Always forward (advanced)</strong> — Every call goes straight to Jessica.<br>
                  <span style="color:#6b7280; font-size:14px;">Dial <span class="forward-highlight">*72 + your AI number</span> then press call</span>
                </li>
                <li>
                  <strong>Phone provider option</strong> — Call your carrier and ask to set up <em>"conditional call forwarding on no answer"</em> to <span id="fwd-number-inline" style="font-weight:700; color:#2563eb;"></span>
                </li>
              </ol>
              <div class="tip-box">
                💡 <strong>Tip:</strong> Most small business owners use <em>forward on no-answer</em> so they can still answer themselves first. Jessica handles the overflow.
              </div>
            </div>
            <div class="btn-row">
              <button class="btn btn-outline" onclick="goToStep(1)">Back</button>
              <button class="btn btn-primary" onclick="goToStep(3)">I've Set Up Forwarding →</button>
            </div>
          </div>
          <div id="setup-error" class="error-msg"></div>
        </div>

        <!-- STEP 3: Test Call -->
        <div class="step" id="step-3">
          <h2>Give her a test call 📞</h2>
          <p class="desc">Call your AI number directly and hear exactly what your customers will experience.</p>
          <div class="test-area">
            <p>Call your number below to hear Jessica answer as <strong id="test-biz-name"></strong></p>
            <div style="margin-bottom:12px; font-size:22px; font-weight:700; color:#065f46;" id="test-number-display"></div>
            <a id="test-call-link" href="tel:" class="btn btn-success" style="font-size:18px; padding:16px 40px; text-decoration:none; display:inline-block;">📞 Call Now</a>
          </div>
          <div class="instructions">
            <h3>What to try on the test call:</h3>
            <ol>
              <li>Ask about your services — Jessica should know them!</li>
              <li>Give a fake name and number to test lead capture</li>
              <li>Ask about hours or pricing</li>
              <li>Check your <a href="/my/dashboard">dashboard</a> after to see the call logged</li>
            </ol>
          </div>
          <div style="background:#fffbeb; border:1px solid #fbbf24; border-radius:8px; padding:16px; margin:16px 0; font-size:14px; color:#78350f;">
            ⚠️ <strong>Reminder:</strong> Don't forget to set up call forwarding on your business line to your new AI number (from Step 2) so real customer calls get through!
          </div>
          <div class="btn-row">
            <button class="btn btn-outline" onclick="goToStep(2)">Back</button>
            <a href="/my/dashboard" class="btn btn-primary">Go to Dashboard →</a>
          </div>
        </div>
      </div>
      <div class="footer">Powered by AI Always Answer</div>

      <script>
        let currentStep = ${hasNumber ? 3 : 1};
        let provisionedNumber = '${customer.twilio_number || ''}';
        let bizName = '${config.businessName || customer.company || ''}';

        function goToStep(n) {
          document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
          document.getElementById('step-' + n).classList.add('active');
          document.querySelectorAll('.progress-step').forEach((s, i) => {
            s.classList.remove('active', 'done');
            if (i < n - 1) s.classList.add('done');
            else if (i === n - 1) s.classList.add('active');
          });
          currentStep = n;

          if (n === 2 && provisionedNumber) {
            document.getElementById('setup-loading').style.display = 'none';
            document.getElementById('setup-result').style.display = 'block';
            const formatted = formatPhone(provisionedNumber);
            document.getElementById('provisioned-number').textContent = formatted;
            const inlineEl = document.getElementById('fwd-number-inline');
            if (inlineEl) inlineEl.textContent = formatted;
          }
          if (n === 3) {
            document.getElementById('test-biz-name').textContent = bizName;
            document.getElementById('test-call-link').href = 'tel:' + provisionedNumber;
            const numDisplay = document.getElementById('test-number-display');
            if (numDisplay) numDisplay.textContent = formatPhone(provisionedNumber);
          }
        }

        function formatPhone(p) {
          const d = p.replace(/\\D/g, '').replace(/^1/, '');
          if (d.length === 10) return '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
          return p;
        }

        function copyNumber() {
          const formatted = formatPhone(provisionedNumber);
          navigator.clipboard.writeText(formatted).then(() => {
            const btn = document.getElementById('copy-number-btn');
            btn.textContent = '✅ Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = '📋 Copy Number';
              btn.classList.remove('copied');
            }, 2000);
          }).catch(() => {
            // Fallback for older browsers
            const el = document.createElement('textarea');
            el.value = formatted;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            const btn = document.getElementById('copy-number-btn');
            btn.textContent = '✅ Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = '📋 Copy Number';
              btn.classList.remove('copied');
            }, 2000);
          });
        }

        // Step 1 form submission
        document.getElementById('biz-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = e.target.querySelector('button[type="submit"]');
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span>Setting up...';

          bizName = document.getElementById('businessName').value;

          goToStep(2);
          document.getElementById('setup-loading').style.display = 'block';
          document.getElementById('setup-result').style.display = 'none';
          document.getElementById('setup-error').style.display = 'none';

          try {
            const res = await fetch('/api/onboarding/setup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                businessName: document.getElementById('businessName').value,
                industry: document.getElementById('industry').value,
                phone: document.getElementById('phone').value,
                address: document.getElementById('address').value,
                hours: document.getElementById('hours').value,
                website: document.getElementById('website').value
              })
            });
            const data = await res.json();
            if (data.success) {
              provisionedNumber = data.twilioNumber;
              document.getElementById('setup-loading').style.display = 'none';
              document.getElementById('setup-result').style.display = 'block';
              document.getElementById('provisioned-number').textContent = formatPhone(data.twilioNumber);
            } else {
              throw new Error(data.error || 'Setup failed');
            }
          } catch (err) {
            document.getElementById('setup-loading').style.display = 'none';
            document.getElementById('setup-error').textContent = err.message;
            document.getElementById('setup-error').style.display = 'block';
          }
          btn.disabled = false;
          btn.textContent = 'Continue';
        });

        // Initialize to correct step
        if (currentStep > 1) goToStep(currentStep);
      </script>
    </body>
    </html>
  `);
});

/**
 * GET /my/dashboard — Customer dashboard with stats, calls, leads, settings
 */
app.get('/my/dashboard', validateCustomerToken, (req, res) => {
  const customer = req.customer;
  const config = customer.ai_config ? JSON.parse(customer.ai_config) : {};

  // Redirect to onboarding if not set up yet
  if (!customer.twilio_number) {
    return res.redirect('/my/onboarding');
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dashboard - AI Always Answer</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #1f2937; }

        .header { background: white; border-bottom: 1px solid #e5e7eb; padding: 0 24px; }
        .header-inner { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; height: 64px; }
        .logo { font-size: 20px; font-weight: 700; color: #2563eb; text-decoration: none; }
        .header-right { display: flex; align-items: center; gap: 16px; }
        .header-right .email { color: #6b7280; font-size: 14px; }
        .header-right a { color: #6b7280; font-size: 14px; text-decoration: none; }
        .header-right a:hover { color: #2563eb; }

        .container { max-width: 1200px; margin: 0 auto; padding: 24px 20px 80px; }
        .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
        .page-subtitle { color: #6b7280; font-size: 15px; margin-bottom: 24px; }

        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
        .stat-card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e5e7eb; }
        .stat-card .label { color: #6b7280; font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
        .stat-card .value { font-size: 32px; font-weight: 700; color: #1f2937; }
        .stat-card .unit { font-size: 14px; color: #9ca3af; font-weight: 400; }

        .card { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e5e7eb; margin-bottom: 24px; overflow: hidden; }
        .card-header { padding: 20px 24px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
        .card-header h2 { font-size: 18px; font-weight: 600; }
        .card-body { padding: 0; }
        .card-body.padded { padding: 24px; }

        table { width: 100%; border-collapse: collapse; }
        th { padding: 12px 24px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
        td { padding: 14px 24px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
        tr:last-child td { border-bottom: none; }
        tr:hover { background: #f9fafb; }
        .empty-row td { text-align: center; color: #9ca3af; padding: 32px; }

        .badge { padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; }
        .badge-blue { background: #dbeafe; color: #1d4ed8; }
        .badge-green { background: #d1fae5; color: #059669; }
        .badge-yellow { background: #fef3c7; color: #b45309; }
        .badge-gray { background: #f3f4f6; color: #6b7280; }

        audio { height: 32px; width: 200px; }

        .phone-number-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .phone-number-box .number { font-size: 20px; font-weight: 700; color: #2563eb; }
        .phone-number-box .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }

        .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .settings-item { display: flex; flex-direction: column; }
        .settings-item .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .settings-item .val { font-size: 15px; color: #1f2937; }

        .tabs { display: flex; border-bottom: 1px solid #e5e7eb; padding: 0 24px; background: white; }
        .tab { padding: 12px 20px; font-size: 14px; font-weight: 500; color: #6b7280; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
        .tab.active { color: #2563eb; border-bottom-color: #2563eb; }
        .tab:hover { color: #2563eb; }

        .tab-content { display: none; }
        .tab-content.active { display: block; }

        .footer { text-align: center; padding: 24px; color: #9ca3af; font-size: 13px; }
        .refresh-badge { font-size: 12px; color: #9ca3af; }

        @media (max-width: 768px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
          .settings-grid { grid-template-columns: 1fr; }
          .header-right .email { display: none; }
          audio { width: 140px; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-inner">
          <a href="/my/dashboard" class="logo">AI Always Answer</a>
          <div class="header-right">
            <span class="email">${customer.email}</span>
            <a href="/my/onboarding">Settings</a>
            <a href="/my/logout">Sign Out</a>
          </div>
        </div>
      </div>

      <div class="container">
        <div class="page-title">${config.businessName || customer.company || 'Your Business'}</div>
        <div class="page-subtitle">AI Receptionist Dashboard <span class="refresh-badge" id="refresh-badge"></span></div>

        <!-- Stats -->
        <div class="stats-grid">
          <div class="stat-card">
            <div class="label">Total Calls</div>
            <div class="value" id="stat-total-calls">--</div>
          </div>
          <div class="stat-card">
            <div class="label">Calls Today</div>
            <div class="value" id="stat-calls-today">--</div>
          </div>
          <div class="stat-card">
            <div class="label">Avg Duration</div>
            <div class="value" id="stat-avg-duration">--<span class="unit">s</span></div>
          </div>
          <div class="stat-card">
            <div class="label">Leads Captured</div>
            <div class="value" id="stat-total-leads">--</div>
          </div>
        </div>

        <!-- Tabs -->
        <div class="card">
          <div class="tabs">
            <div class="tab active" data-tab="calls">Call Log</div>
            <div class="tab" data-tab="leads">Leads</div>
            <div class="tab" data-tab="settings">Settings</div>
          </div>

          <!-- Call Log Tab -->
          <div class="tab-content active" id="tab-calls">
            <table>
              <thead>
                <tr>
                  <th>Date / Time</th>
                  <th>Caller</th>
                  <th>Duration</th>
                  <th>Outcome</th>
                  <th>Recording</th>
                </tr>
              </thead>
              <tbody id="calls-tbody">
                <tr class="empty-row"><td colspan="5">Loading calls...</td></tr>
              </tbody>
            </table>
          </div>

          <!-- Leads Tab -->
          <div class="tab-content" id="tab-leads">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="leads-tbody">
                <tr class="empty-row"><td colspan="5">Loading leads...</td></tr>
              </tbody>
            </table>
          </div>

          <!-- Settings Tab -->
          <div class="tab-content" id="tab-settings">
            <div class="card-body padded">
              <div class="phone-number-box">
                <div>
                  <div class="label">Your AI Receptionist Number</div>
                  <div class="number">${formatPhoneServer(customer.twilio_number)}</div>
                </div>
                <div>
                  <div class="label">Plan</div>
                  <div style="font-weight:600; text-transform:capitalize;">${customer.plan || 'basic'}</div>
                </div>
              </div>
              <div class="settings-grid">
                <div class="settings-item">
                  <div class="label">Business Name</div>
                  <div class="val">${config.businessName || '-'}</div>
                </div>
                <div class="settings-item">
                  <div class="label">Industry</div>
                  <div class="val">${config.industry || '-'}</div>
                </div>
                <div class="settings-item">
                  <div class="label">Phone</div>
                  <div class="val">${config.phone || '-'}</div>
                </div>
                <div class="settings-item">
                  <div class="label">Address / Area</div>
                  <div class="val">${config.address || '-'}</div>
                </div>
                <div class="settings-item">
                  <div class="label">Hours</div>
                  <div class="val">${config.hours || '-'}</div>
                </div>
                <div class="settings-item">
                  <div class="label">Website</div>
                  <div class="val">${config.website || '-'}</div>
                </div>
              </div>
              <div style="margin-top:24px;">
                <a href="/my/onboarding" class="btn" style="padding:10px 20px; background:#2563eb; color:white; text-decoration:none; border-radius:8px; font-size:14px; font-weight:600;">Edit Business Info</a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="footer">Powered by AI Always Answer</div>

      <script>
        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
          tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
          });
        });

        function escapeHtml(str) {
          if (!str) return '';
          return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function formatDate(d) {
          if (!d) return '-';
          const dt = new Date(d);
          return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }

        function formatDuration(s) {
          if (!s) return '0s';
          if (s < 60) return s + 's';
          return Math.floor(s/60) + 'm ' + (s%60) + 's';
        }

        function outcomeBadge(o) {
          if (!o) return '<span class="badge badge-gray">-</span>';
          const cls = o.includes('lead') || o.includes('booked') ? 'badge-green' : o.includes('no') ? 'badge-yellow' : 'badge-blue';
          return '<span class="badge ' + cls + '">' + escapeHtml(o) + '</span>';
        }

        async function loadData() {
          try {
            const [statsRes, callsRes, leadsRes] = await Promise.all([
              fetch('/api/my/stats'),
              fetch('/api/my/calls?limit=50'),
              fetch('/api/my/leads?limit=50')
            ]);
            const stats = await statsRes.json();
            const calls = await callsRes.json();
            const leads = await leadsRes.json();

            // Stats
            document.getElementById('stat-total-calls').textContent = stats.totalCalls;
            document.getElementById('stat-calls-today').textContent = stats.callsToday;
            document.getElementById('stat-avg-duration').innerHTML = stats.avgDuration + '<span class="unit">s</span>';
            document.getElementById('stat-total-leads').textContent = stats.totalLeads;

            // Calls
            if (calls.length === 0) {
              document.getElementById('calls-tbody').innerHTML = '<tr class="empty-row"><td colspan="5">No calls yet. Forward your calls to start seeing data here.</td></tr>';
            } else {
              document.getElementById('calls-tbody').innerHTML = calls.map(function(c) {
                let recording = '<span style="color:#9ca3af">-</span>';
                if (c.recording_url) {
                  const m = c.recording_url.match(/Recordings\\/(RE[a-zA-Z0-9]+)/);
                  if (m) recording = '<audio controls preload="none" style="height:32px" src="/api/recordings/' + m[1] + '"></audio>';
                }
                return '<tr>'
                  + '<td>' + formatDate(c.created_at) + '</td>'
                  + '<td>' + escapeHtml(c.lead_name || c.phone_from || '-') + '</td>'
                  + '<td>' + formatDuration(c.duration_seconds) + '</td>'
                  + '<td>' + outcomeBadge(c.outcome) + '</td>'
                  + '<td>' + recording + '</td>'
                  + '</tr>';
              }).join('');
            }

            // Leads
            if (leads.length === 0) {
              document.getElementById('leads-tbody').innerHTML = '<tr class="empty-row"><td colspan="5">No leads captured yet.</td></tr>';
            } else {
              document.getElementById('leads-tbody').innerHTML = leads.map(function(l) {
                const statusCls = l.status === 'new' ? 'badge-blue' : l.status === 'contacted' ? 'badge-yellow' : l.status === 'converted' ? 'badge-green' : 'badge-gray';
                return '<tr>'
                  + '<td>' + formatDate(l.created_at) + '</td>'
                  + '<td>' + escapeHtml(l.name || '-') + '</td>'
                  + '<td>' + escapeHtml(l.phone) + '</td>'
                  + '<td>' + escapeHtml(l.email || '-') + '</td>'
                  + '<td><span class="badge ' + statusCls + '">' + escapeHtml(l.status) + '</span></td>'
                  + '</tr>';
              }).join('');
            }

            document.getElementById('refresh-badge').textContent = 'Updated ' + new Date().toLocaleTimeString();
          } catch (err) {
            console.error('Failed to load dashboard data:', err);
          }
        }

        loadData();
        setInterval(loadData, 30000);
      </script>
    </body>
    </html>
  `);
});

// HVAC landing page variant (clean URL)
app.get('/hvac', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hvac.html'));
});

// Serve landing page for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Format phone number for display (server-side)
 */
function formatPhoneServer(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '').replace(/^1/, '');
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  return phone;
}

/**
 * Extract lead info from speech using simple pattern matching
 */
function extractLeadInfo(speech, leadId, businessId) {
  const speechLower = speech.toLowerCase();
  const updates = {};

  // Extract name
  const namePatterns = [
    /my name is (\w+(?:\s+\w+)?)/i,
    /i'm (\w+)/i,
    /this is (\w+)/i,
    /call me (\w+)/i
  ];

  for (const pattern of namePatterns) {
    const match = speech.match(pattern);
    if (match) {
      updates.name = match[1];
      break;
    }
  }

  // Extract company mentions
  const companyPatterns = [
    /(?:from|at|with) (\w+(?:\s+\w+)?(?:\s+(?:inc|llc|corp|company|co))?)/i,
    /(\w+(?:\s+\w+)?(?:\s+(?:inc|llc|corp|company|co)))/i
  ];

  for (const pattern of companyPatterns) {
    const match = speech.match(pattern);
    if (match && match[1].length > 2) {
      updates.company = match[1];
      break;
    }
  }

  // Extract email addresses
  const emailPattern = /([a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+\s*\.\s*[a-zA-Z]{2,4})/i;
  const emailMatch = speech.match(emailPattern);
  if (emailMatch) {
    updates.email = emailMatch[1].replace(/\s+/g, '');
  }

  // Detect urgency/interest based on keywords
  const emergencyKeywords = ['emergency', 'flooding', 'sewage', 'backing up', 'overflow', 'backed up', 'urgent', 'asap'];
  const highInterestKeywords = ['pricing', 'how much', 'cost', 'quote', 'schedule', 'appointment', 'need', 'today'];
  const mediumInterestKeywords = ['interested', 'tell me more', 'information', 'question'];

  if (emergencyKeywords.some(kw => speechLower.includes(kw))) {
    updates.interest_level = 'emergency';
  } else if (highInterestKeywords.some(kw => speechLower.includes(kw))) {
    updates.interest_level = 'high';
  } else if (mediumInterestKeywords.some(kw => speechLower.includes(kw))) {
    updates.interest_level = 'medium';
  }

  // For septic business, extract location mentions
  if (businessId === 'fixsepticnow') {
    const cities = ['conroe', 'woodlands', 'the woodlands', 'huntsville', 'spring', 'tomball', 'magnolia', 'willis', 'new waverly', 'houston', 'montgomery', 'cleveland', 'humble', 'kingwood', 'atascocita', 'porter', 'splendora', 'cut and shoot'];
    for (const city of cities) {
      if (speechLower.includes(city)) {
        updates.notes = (updates.notes || '') + `Location: ${city}. `;
        break;
      }
    }
  }

  // Update lead in database
  if (Object.keys(updates).length > 0 && leadId) {
    try {
      db.db.prepare(`UPDATE leads SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...Object.values(updates), leadId);
    } catch (e) {
      console.error('Error updating lead info:', e);
    }
  }
}

/**
 * Save call data when call ends
 */
async function saveCallData(callSid, conversationManager) {
  const history = conversationManager.getFullHistory();

  // Build transcript
  const transcript = history.messages
    .map(m => `${m.role === 'user' ? 'Caller' : 'AI'}: ${m.content}`)
    .join('\n\n');

  // Update call record
  db.updateCall(callSid, {
    duration_seconds: Math.floor(history.duration / 1000),
    turn_count: history.turnCount,
    transcript: transcript
  });

  // Get lead and send notification to the correct business email
  const call = db.getCallBySid(callSid);
  const business = conversationManager.businessConfig || getBusinessById('widescope');
  if (call && call.lead_id) {
    const lead = db.getLeads().find(l => l.id === call.lead_id);
    if (lead) {
      await emailService.notifyNewLead(lead, {
        duration: Math.floor(history.duration / 1000),
        turns: history.turnCount,
        transcript: transcript,
        businessName: business?.name || 'AI Receptionist',
        businessId: business?.id || 'unknown'
      }, business?.notifyEmail);

      // For AI Always Answer business, also send setup link if email captured
      if (business?.id === 'widescope' && lead.email) {
        await emailService.sendSetupLink(lead.email, lead.name || lead.company || 'there');
      }
    }
  }

  console.log(`💾 Saved call data for ${callSid}`);
}

// ==================== SERVER STARTUP (HTTP + WebSocket) ====================

const server = http.createServer(app);

// WebSocket server for OpenAI Realtime voice streams (no automatic upgrade — we handle it manually)
const realtimeWss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade requests for /voice/realtime-stream
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === '/voice/realtime-stream') {
    realtimeWss.handleUpgrade(request, socket, head, (ws) => {
      realtimeWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// When Twilio connects via WebSocket, bridge to OpenAI Realtime API
realtimeWss.on('connection', (twilioWs) => {
  console.log('[Realtime] New Twilio Media Stream WebSocket connection');

  // We need to wait for the 'start' event from Twilio to get the callSid,
  // then look up the pending session data.
  let initialized = false;

  twilioWs.on('message', (data) => {
    if (initialized) return; // After init, the realtime service handles all messages

    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === 'start') {
        // Extract callSid from custom parameters or from the start message
        const customParams = msg.start.customParameters || {};
        const callSid = customParams.callSid || msg.start.callSid;

        console.log(`[Realtime] Stream start — callSid: ${callSid}`);

        const sessionOpts = pendingRealtimeSessions.get(callSid);
        if (!sessionOpts) {
          console.error(`[Realtime] No pending session found for callSid ${callSid}`);
          twilioWs.close();
          return;
        }

        // Clean up pending session
        pendingRealtimeSessions.delete(callSid);

        // Hand off to the realtime service — it will handle all further messages
        initialized = true;
        realtimeService.handleTwilioConnection(twilioWs, {
          ...sessionOpts,
          conversations
        });

        // Re-emit the start message so the service sees it
        twilioWs.emit('message', data);
      }
    } catch (err) {
      console.error('[Realtime] Error in pre-init message handler:', err.message);
    }
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Receptionist server running on port ${PORT}`);
  console.log(`📱 Webhook URL: ${process.env.BASE_URL || `http://localhost:${PORT}`}/voice/incoming`);
  if (process.env.VOICE_ENGINE === 'openai-realtime') {
    console.log(`🎙️ Voice engine: OpenAI Realtime (full-duplex)`);
  } else {
    console.log(`🎙️ Voice engine: ElevenLabs TTS (half-duplex)`);
  }
  console.log(`🌐 Landing page: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`📊 Dashboard: ${process.env.BASE_URL || `http://localhost:${PORT}`}/dashboard`);
});

module.exports = app;
