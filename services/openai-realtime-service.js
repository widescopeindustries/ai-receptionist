const WebSocket = require('ws');
const emailService = require('./email-service');
const db = require('./database');
const ConversationManager = require('./conversation-manager');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
const LOG_PREFIX = '[Realtime]';

/**
 * OpenAI Realtime Service — bridges Twilio Media Streams ↔ OpenAI Realtime API
 *
 * Audio flows directly as g711_ulaw (mulaw 8kHz) in both directions.
 * OpenAI Realtime API supports g711_ulaw natively, so no resampling needed.
 */
class OpenAIRealtimeService {
  constructor() {
    // streamSid → session state (for cleanup on disconnect)
    this.sessions = new Map();
  }

  /**
   * Get the API key for the Realtime API
   */
  getApiKey() {
    return process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
  }

  /**
   * Build Realtime API tool definitions matching ai-service.js tools
   */
  getTools() {
    return [
      {
        type: 'function',
        name: 'capture_lead',
        description: "Call this as soon as you have the caller's name, email, and website. This notifies the owner to follow up within 10 minutes.",
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
      },
      {
        type: 'function',
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
    ];
  }

  /**
   * Handle a new Twilio Media Stream WebSocket connection.
   *
   * @param {WebSocket} twilioWs — the Twilio-side WebSocket
   * @param {Object} opts
   * @param {string} opts.callSid
   * @param {string} opts.systemPrompt — full system prompt (with caller context baked in)
   * @param {string} opts.greeting — the greeting text the AI should speak first
   * @param {Object} opts.businessConfig
   * @param {number} opts.leadId
   * @param {number} opts.callId
   * @param {Map} opts.conversations — reference to the global conversations Map
   */
  handleTwilioConnection(twilioWs, opts) {
    const {
      callSid,
      systemPrompt,
      greeting,
      businessConfig,
      leadId,
      callId,
      conversations,
    } = opts;

    const session = {
      callSid,
      streamSid: null,
      openaiWs: null,
      conversationManager: new ConversationManager(callSid),
      businessConfig,
      lastAssistantItemId: null, // track for truncation on interruption
    };

    session.conversationManager.leadId = leadId;
    session.conversationManager.callId = callId;
    session.conversationManager.businessId = businessConfig.id;
    session.conversationManager.businessConfig = businessConfig;

    // Add greeting to conversation history (it will be spoken by the AI)
    session.conversationManager.addMessage('assistant', greeting);

    // Store in global conversations map for /voice/status cleanup
    conversations.set(callSid, session.conversationManager);

    console.log(`${LOG_PREFIX} Opening OpenAI Realtime connection for call ${callSid}`);

    // ── Connect to OpenAI Realtime API ──────────────────────────────
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.error(`${LOG_PREFIX} No OpenAI API key available!`);
      twilioWs.close();
      return;
    }

    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    session.openaiWs = openaiWs;

    // ── OpenAI WebSocket events ─────────────────────────────────────

    openaiWs.on('open', () => {
      console.log(`${LOG_PREFIX} Connected to OpenAI Realtime API`);
      this._configureSession(openaiWs, systemPrompt);
      this._sendInitialGreeting(openaiWs, greeting);
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        this._handleOpenAIEvent(event, session, twilioWs);
      } catch (err) {
        console.error(`${LOG_PREFIX} Error parsing OpenAI message:`, err.message);
      }
    });

    openaiWs.on('error', (err) => {
      console.error(`${LOG_PREFIX} OpenAI WebSocket error:`, err.message);
    });

    openaiWs.on('close', (code, reason) => {
      console.log(`${LOG_PREFIX} OpenAI WebSocket closed: ${code} ${reason}`);
    });

    // ── Twilio WebSocket events ─────────────────────────────────────

    twilioWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleTwilioMessage(msg, session);
      } catch (err) {
        console.error(`${LOG_PREFIX} Error parsing Twilio message:`, err.message);
      }
    });

    twilioWs.on('close', () => {
      console.log(`${LOG_PREFIX} Twilio WebSocket closed for call ${callSid}`);
      this._cleanup(session, conversations);
    });

    twilioWs.on('error', (err) => {
      console.error(`${LOG_PREFIX} Twilio WebSocket error:`, err.message);
    });

    // Track session for cleanup
    this.sessions.set(callSid, session);
  }

  // ── Private: Configure the OpenAI Realtime session ──────────────

  _configureSession(openaiWs, systemPrompt) {
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: 'shimmer',
        instructions: systemPrompt,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
        tools: this.getTools(),
        tool_choice: 'auto',
        temperature: 0.7
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  }

  // ── Private: Trigger the AI to speak the greeting ─────────────

  _sendInitialGreeting(openaiWs, greeting) {
    // Inject a hidden user message to prompt the greeting, then create response
    openaiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `[System: A caller just connected. Greet them with exactly this opening line, word for word: "${greeting}"]`
        }]
      }
    }));

    openaiWs.send(JSON.stringify({ type: 'response.create' }));
  }

  // ── Private: Handle messages from Twilio Media Stream ─────────

  _handleTwilioMessage(msg, session) {
    switch (msg.event) {
      case 'connected':
        console.log(`${LOG_PREFIX} Twilio media stream connected`);
        break;

      case 'start':
        session.streamSid = msg.start.streamSid;
        console.log(`${LOG_PREFIX} Stream started: ${session.streamSid} (callSid: ${msg.start.callSid})`);
        break;

      case 'media':
        // Forward audio from Twilio → OpenAI (already g711_ulaw)
        if (session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
          session.openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload // base64 mulaw audio
          }));
        }
        break;

      case 'stop':
        console.log(`${LOG_PREFIX} Twilio stream stopped for ${session.callSid}`);
        break;
    }
  }

  // ── Private: Handle events from OpenAI Realtime API ───────────

  _handleOpenAIEvent(event, session, twilioWs) {
    switch (event.type) {
      case 'session.created':
        console.log(`${LOG_PREFIX} Session created: ${event.session.id}`);
        break;

      case 'session.updated':
        console.log(`${LOG_PREFIX} Session configured`);
        break;

      case 'response.audio.delta':
        // Stream audio from OpenAI → Twilio
        if (session.streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: {
              payload: event.delta // base64 g711_ulaw audio
            }
          }));
        }
        break;

      case 'response.audio_transcript.done':
        // Log the assistant's full spoken text
        if (event.transcript) {
          console.log(`${LOG_PREFIX} AI said: ${event.transcript.substring(0, 100)}...`);
          session.conversationManager.addMessage('assistant', event.transcript);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // Log what the caller said (transcribed by Whisper)
        if (event.transcript) {
          const text = event.transcript.trim();
          if (text) {
            console.log(`${LOG_PREFIX} Caller said: ${text}`);
            session.conversationManager.addMessage('user', text);

            // Extract lead info from speech (same regex logic as existing flow)
            this._extractLeadInfo(text, session.conversationManager.leadId, session.conversationManager.businessId);
          }
        }
        break;

      case 'input_audio_buffer.speech_started':
        // Caller started speaking — interrupt any in-progress AI audio
        this._handleInterruption(session, twilioWs);
        break;

      case 'response.function_call_arguments.done':
        // A tool call completed — execute it
        this._handleToolCall(event, session);
        break;

      case 'response.done':
        // Track the last assistant item ID for truncation on interruption
        if (event.response && event.response.output) {
          for (const item of event.response.output) {
            if (item.type === 'message' && item.role === 'assistant') {
              session.lastAssistantItemId = item.id;
            }
          }
        }
        break;

      case 'error':
        console.error(`${LOG_PREFIX} OpenAI error:`, event.error);
        break;
    }
  }

  // ── Private: Handle caller interruption ───────────────────────

  _handleInterruption(session, twilioWs) {
    // Clear Twilio's audio playback buffer
    if (session.streamSid && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({
        event: 'clear',
        streamSid: session.streamSid
      }));
      console.log(`${LOG_PREFIX} Cleared Twilio audio buffer (caller interrupted)`);
    }

    // Cancel the in-progress response on OpenAI side
    if (session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
      session.openaiWs.send(JSON.stringify({ type: 'response.cancel' }));

      // Truncate the assistant's last message so the model knows what was actually heard
      if (session.lastAssistantItemId) {
        session.openaiWs.send(JSON.stringify({
          type: 'conversation.item.truncate',
          item_id: session.lastAssistantItemId,
          content_index: 0,
          audio_end_ms: 0
        }));
      }
    }
  }

  // ── Private: Execute tool calls from the Realtime API ─────────

  async _handleToolCall(event, session) {
    const { name, call_id, arguments: argsStr } = event;
    let args;
    try {
      args = JSON.parse(argsStr);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to parse tool args:`, err.message);
      this._sendToolResult(session, call_id, 'Error parsing arguments.');
      return;
    }

    console.log(`${LOG_PREFIX} Tool call: ${name}(${JSON.stringify(args)})`);

    if (name === 'capture_lead') {
      const callTime = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
      const phone = session.callSid; // We'll get actual phone from call record

      // Get the caller's phone from the DB call record
      let callerPhone = null;
      try {
        const callRecord = db.getCallBySid(session.callSid);
        callerPhone = callRecord?.phone_from || null;
      } catch (e) { /* ignore */ }

      console.log(`${LOG_PREFIX} Lead captured: ${args.name} | ${args.email} | ${args.website || 'no website'}`);

      // Send email alert (same as existing flow)
      emailService.sendLeadAlert({
        name: args.name,
        email: args.email,
        website: args.website || 'Not provided',
        businessType: args.businessType || 'Unknown',
        phone: callerPhone,
        callTime
      }).catch(err => {
        console.error(`${LOG_PREFIX} Lead alert email error:`, err.message);
      });

      // Update lead in DB if we have info
      if (session.conversationManager.leadId) {
        try {
          const updates = [];
          const values = [];
          if (args.name) { updates.push('name = ?'); values.push(args.name); }
          if (args.email) { updates.push('email = ?'); values.push(args.email); }
          if (args.businessType) { updates.push('company = ?'); values.push(args.businessType); }
          if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(session.conversationManager.leadId);
            db.db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...values);
          }
        } catch (e) {
          console.error(`${LOG_PREFIX} Lead update error:`, e.message);
        }
      }

      this._sendToolResult(session, call_id, 'Lead captured and owner notified. They will follow up within 10 minutes.');
    } else if (name === 'send_setup_link') {
      console.log(`${LOG_PREFIX} Sending setup link to ${args.email}`);

      emailService.sendSetupLink(args.email, args.email).catch(err => {
        console.error(`${LOG_PREFIX} Setup link email error:`, err.message);
      });

      this._sendToolResult(session, call_id, 'Setup link sent to their email.');
    } else {
      this._sendToolResult(session, call_id, `Unknown tool: ${name}`);
    }
  }

  /**
   * Send a tool result back to OpenAI and trigger a follow-up response
   */
  _sendToolResult(session, callId, result) {
    if (!session.openaiWs || session.openaiWs.readyState !== WebSocket.OPEN) return;

    // Send the function call output
    session.openaiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: result
      }
    }));

    // Trigger the AI to respond based on the tool result
    session.openaiWs.send(JSON.stringify({ type: 'response.create' }));
  }

  // ── Private: Extract lead info from speech (mirrors server.js) ─

  _extractLeadInfo(speech, leadId, businessId) {
    if (!leadId) return;

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

    // Extract email
    const emailPattern = /([a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+\s*\.\s*[a-zA-Z]{2,4})/i;
    const emailMatch = speech.match(emailPattern);
    if (emailMatch) {
      updates.email = emailMatch[1].replace(/\s+/g, '');
    }

    if (Object.keys(updates).length > 0) {
      try {
        db.db.prepare(
          `UPDATE leads SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(...Object.values(updates), leadId);
      } catch (e) {
        console.error(`${LOG_PREFIX} extractLeadInfo error:`, e.message);
      }
    }
  }

  // ── Private: Cleanup when connection closes ───────────────────

  async _cleanup(session, conversations) {
    // Close OpenAI WebSocket if still open
    if (session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
      session.openaiWs.close();
    }

    // Save call data (transcript, duration, turns)
    try {
      const history = session.conversationManager.getFullHistory();
      const transcript = history.messages
        .map(m => `${m.role === 'user' ? 'Caller' : 'AI'}: ${m.content}`)
        .join('\n\n');

      db.updateCall(session.callSid, {
        duration_seconds: Math.floor(history.duration / 1000),
        turn_count: history.turnCount,
        transcript: transcript
      });

      console.log(`${LOG_PREFIX} Saved call data for ${session.callSid} (${history.turnCount} turns)`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Error saving call data:`, err.message);
    }

    // Remove from tracking maps
    conversations.delete(session.callSid);
    this.sessions.delete(session.callSid);
  }
}

module.exports = new OpenAIRealtimeService();
