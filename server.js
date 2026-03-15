require('dotenv').config();
const express = require('express');
const path = require('path');
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

// Store active conversations
const conversations = new Map();

/**
 * ElevenLabs TTS endpoint — Twilio plays this URL instead of using twiml.say()
 * Usage: /voice/tts?text=Hello+there
 */
app.get('/voice/tts', (req, res) => {
  const text = req.query.text || 'Hello';
  console.log(`🎙️  ElevenLabs TTS: "${text.substring(0, 60)}..."`);
  elevenLabs.streamTTS(text, res);
});

/**
 * Helper: build a twiml.play() URL for ElevenLabs TTS
 * Falls back to twiml.say() if ElevenLabs is not configured
 */
function speakText(twiml, text, fallbackVoice) {
  const cleaned = cleanTextForTTS(text);
  if (process.env.ELEVENLABS_API_KEY) {
    const encoded = encodeURIComponent(cleaned);
    const baseUrl = process.env.BASE_URL || 'https://aialwaysanswer.com';
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
 */
app.post('/voice/incoming', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const phoneFrom = req.body.From;
  const phoneTo = req.body.To;
  const callerName = req.body.CallerName || null;
  const callerCity = req.body.FromCity || null;
  const callerState = req.body.FromState || null;
  const callerZip = req.body.FromZip || null;

  // Look up business config by the Twilio number that was called
  const business = getBusinessByNumber(phoneTo);
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
    const callbackGreeting = `Hey! ${bizName}! I was hoping to hear back from you! Thanks so much for calling me back. So, like I mentioned in my message, I'm Jessica, an AI receptionist, and I can answer your phones 24 7 so you never miss another customer. What questions can I answer for you?`;
    
    // Override the system prompt so Jessica knows the context for the whole conversation
    conversationManager.businessConfig = {
      ...business,
      greeting: callbackGreeting,
      systemPrompt: `You are Jessica, an AI receptionist from AI Always Answer. You left a voicemail for ${bizName} and they are calling you back. You are warm, enthusiastic, and genuinely excited they called back.

KEY FACTS TO REFERENCE:
- 85% of callers don't leave voicemails — they call a competitor instead
- 62% of missed calls go straight to the competition
- You cost $99/month — way cheaper than missing even one job
- You answer 24/7, book appointments, capture leads, and sound like a real person

YOUR GOAL: Get them excited about the service and close the sale. Be conversational and natural.

CLOSING THE SALE:
- If they're interested, tell them you can get them set up today — it takes about 5 minutes
- Ask for their email to send the signup link
- If they want to know more, offer to show them a live demo right now on the call
- Be confident but not pushy. The voicemail already did the hard sell — now you're just answering questions and making it easy to say yes.

PRICING:
- $99/month for 24/7 AI receptionist
- No contracts, cancel anytime
- Usually pays for itself with one captured job

Remember: they called YOU back. They're already interested. Make it easy for them to say yes.${callerContextStr}`
    };
    
    speakText(twiml, callbackGreeting, business.voice);
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
                <th>Date</th>
              </tr>
            </thead>
            <tbody id="calls-table">
              <tr><td colspan="5">Loading...</td></tr>
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
            const callsHtml = data.recentCalls.map(call => [
              '<tr>',
              '<td>' + (call.phone || call.phone_from) + '</td>',
              '<td>' + (call.duration_seconds || 0) + 's</td>',
              '<td>' + (call.turn_count || 0) + '</td>',
              '<td>' + (call.outcome || '-') + '</td>',
              '<td>' + new Date(call.created_at).toLocaleDateString() + '</td>',
              '</tr>'
            ].join('')).join('') || '<tr><td colspan="5">No calls yet</td></tr>';
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
          <p>Your ${plan || ''} subscription is now active. We'll send you an email with next steps to configure your AI receptionist.</p>
          <a href="/dashboard" class="btn">Go to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } else {
    res.redirect('/');
  }
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
  
  console.log(`📞 Outbound call answered: ${answeredBy} (${businessName || 'unknown business'})`);
  
  if (answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other') {
    // Voicemail detected — leave the message
    const script = outbound.getVoicemailScript(businessName);
    speakText(twiml, script);
    twiml.pause({ length: 1 });
    twiml.hangup();
    console.log(`📝 Voicemail left for: ${businessName || 'unknown'}`);
  } else if (answeredBy === 'human') {
    // Human answered — short live pitch
    const livePitch = businessName
      ? `Oh wow, hi! This is Jessica from AI Always Answer. I'm honestly surprised someone picked up, I was calling after hours expecting to get your voicemail. ` +
        `That actually makes my point though... did you know that 85 percent of your customers won't wait for voicemail? They just hang up and call the next company. ` +
        `I'm an AI receptionist and I can answer every call for ${businessName}, 24 7, book appointments, and capture every lead... ` +
        `and you're not going to believe this... it's 99 bucks a month. ` +
        `Can I send you a quick demo? You'll see exactly how I'd answer calls for your business.`
      : `Oh wow, hi! I'm Jessica from AI Always Answer. I was honestly expecting your voicemail. ` +
        `Did you know 85 percent of callers won't leave a voicemail? They just call your competitor instead. ` +
        `I'm an AI receptionist, 99 bucks a month, I answer every call 24 7. Can I send you a quick demo?`;
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
  } else {
    // Unknown / machine_start — just leave the voicemail to be safe
    const script = outbound.getVoicemailScript(businessName);
    speakText(twiml, script);
    twiml.pause({ length: 1 });
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
    // TODO: trigger demo drop + SMS with link
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

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Receptionist server running on port ${PORT}`);
  console.log(`📱 Webhook URL: ${process.env.BASE_URL || `http://localhost:${PORT}`}/voice/incoming`);
  console.log(`🌐 Landing page: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`📊 Dashboard: ${process.env.BASE_URL || `http://localhost:${PORT}`}/dashboard`);
});

module.exports = app;
