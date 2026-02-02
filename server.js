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

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Explicit SEO routes
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

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

// Initialize AI Service
const aiService = new AIService();

// ==================== TWILIO VOICE ENDPOINTS ====================

/**
 * Main webhook endpoint - Twilio calls this when someone dials your number
 */
app.post('/voice/incoming', async (req, res) => {
  console.log('📞 Incoming call from:', req.body.From);

  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const phoneFrom = req.body.From;
  const phoneTo = req.body.To;

  // Create call record in database
  const { callId, leadId } = db.createCall(callSid, phoneFrom, phoneTo);

  // Initialize conversation for this call
  const conversationManager = new ConversationManager(callSid);
  conversationManager.leadId = leadId;
  conversationManager.callId = callId;
  conversations.set(callSid, conversationManager);

  // Greet the caller
  const greeting = "AI Always Answer. I don't do voicemail, I do business. Who am I speaking with?";

  twiml.say({
    voice: 'Polly.Danielle-Neural',
    language: 'en-US'
  }, greeting);

  // Add the greeting to conversation history
  conversationManager.addMessage('assistant', greeting);

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
      // Extract lead info from speech
      extractLeadInfo(userSpeech, conversationManager.leadId);
    } else {
      twiml.redirect('/voice/no-input');
      return res.send(twiml.toString());
    }

    // Get AI response
    const aiResponse = await aiService.getResponse(
      conversationManager.getHistory(),
      userSpeech
    );

    console.log('🤖 AI responds:', aiResponse);

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
    twiml.say({
      voice: 'Polly.Danielle-Neural',
      language: 'en-US'
    }, finalSpeechResponse);

    // Check if conversation should end
    if (conversationManager.shouldEndCall(finalSpeechResponse)) {
      twiml.say({
        voice: 'Polly.Danielle-Neural',
        language: 'en-US'
      }, 'Have a great day! Goodbye!');

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

    twiml.say({
      voice: 'Polly.Danielle-Neural',
      language: 'en-US'
    }, 'I apologize, I\'m having trouble understanding. Let\'s get back to business.');

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

  twiml.say({
    voice: 'Polly.Danielle-Neural',
    language: 'en-US'
  }, 'Are you still there? I\'m ready to help whenever you are!');

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
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody id="leads-table">
              <tr><td colspan="5">Loading...</td></tr>
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
            const leadsHtml = data.recentLeads.map(lead => `
              <tr>
                <td>${lead.phone}</td>
                <td>${lead.name || '-'}</td>
                <td>${lead.company || '-'}</td>
                <td><span class="status status-${lead.status}">${lead.status}</span></td>
                <td>${new Date(lead.created_at).toLocaleDateString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="5">No leads yet</td></tr>';
            document.getElementById('leads-table').innerHTML = leadsHtml;

            // Render calls
            const callsHtml = data.recentCalls.map(call => `
              <tr>
                <td>${call.phone || call.phone_from}</td>
                <td>${call.duration_seconds || 0}s</td>
                <td>${call.turn_count || 0}</td>
                <td>${call.outcome || '-'}</td>
                <td>${new Date(call.created_at).toLocaleDateString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="5">No calls yet</td></tr>';
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

// Serve landing page for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Extract lead info from speech using simple pattern matching
 */
function extractLeadInfo(speech, leadId) {
  const speechLower = speech.toLowerCase();
  const updates = {};

  // Extract name (look for "my name is", "I'm", "this is")
  const namePatterns = [
    /my name is ([a-z]+)/i,
    /i'm ([a-z]+)/i,
    /this is ([a-z]+)/i,
    /call me ([a-z]+)/i
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
    updates.email = emailMatch[1].replace(/\s+/g, ''); // Remove spaces
  }

  // Detect interest level based on keywords
  if (speechLower.includes('pricing') || speechLower.includes('how much') || speechLower.includes('cost')) {
    updates.interest_level = 'high';
  } else if (speechLower.includes('interested') || speechLower.includes('tell me more')) {
    updates.interest_level = 'medium';
  }

  // Update lead in database
  if (Object.keys(updates).length > 0) {
    db.db.prepare(`UPDATE leads SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...Object.values(updates), leadId);
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

  // Get lead and send notification
  const call = db.getCallBySid(callSid);
  if (call && call.lead_id) {
    const lead = db.getLeads().find(l => l.id === call.lead_id);
    if (lead) {
      // 1. Notify Lyndon (the owner)
      await emailService.notifyNewLead(lead, {
        duration: Math.floor(history.duration / 1000),
        turns: history.turnCount,
        transcript: transcript
      });

      // 2. If email was captured, send the setup link to the prospect
      if (lead.email) {
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