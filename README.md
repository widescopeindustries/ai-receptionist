# AI Receptionist - Sales Demo Agent

An AI-powered phone receptionist that sells AI receptionist services by demonstrating them in real-time. When prospects call your Twilio number, they interact with an AI that showcases the product while explaining its benefits.

## 🎯 What It Does

- **Answers calls 24/7** via your Twilio number
- **Engages in natural conversation** using GPT-4 or Claude
- **Demonstrates AI receptionist capabilities** in real-time
- **Sells the service** by being the service (meta approach!)
- **Qualifies leads** and collects contact information
- **Provides pricing** and scheduling information

## 🏗️ Tech Stack

- **Node.js + Express** - Web server
- **Twilio Voice API** - Phone call handling & speech recognition
- **OpenAI GPT-4** or **Anthropic Claude** - AI conversation
- **Twilio TTS** - Text-to-speech (Polly.Joanna voice)

## 📋 Prerequisites

1. **Twilio Account** with:
   - Phone number
   - Account SID
   - Auth Token

2. **AI API Key** (choose one):
   - OpenAI API key (GPT-4)
   - Anthropic API key (Claude)

3. **Public URL** for webhooks (options):
   - Production: Deploy to Heroku, Railway, DigitalOcean, etc.
   - Development: Use [ngrok](https://ngrok.com/) for local testing

## 🚀 Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Twilio Configuration
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# AI Configuration (choose one)
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
# OR
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxx

AI_PROVIDER=openai  # or 'anthropic'

# Server Configuration
PORT=3000
BASE_URL=https://your-domain.com  # or ngrok URL
```

### 3. Start the Server

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

### 4. Expose Your Server (for development)

If testing locally, use ngrok:

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

### 5. Configure Twilio Webhook

1. Go to [Twilio Console](https://console.twilio.com/)
2. Navigate to **Phone Numbers** → **Manage** → **Active Numbers**
3. Click your phone number
4. Under **Voice Configuration**:
   - **A CALL COMES IN**: Webhook
   - **URL**: `https://your-domain.com/voice/incoming` (or ngrok URL)
   - **HTTP**: POST
5. Under **Status Callback URL**:
   - **URL**: `https://your-domain.com/voice/status`
   - **HTTP**: POST
6. Click **Save**

## 📞 Testing

1. Call your Twilio number
2. The AI receptionist will greet you
3. Have a conversation about AI receptionist services
4. Check server logs to see the conversation flow

## 🎭 How It Works

```
📱 Call Received
    ↓
🔊 AI Greets Caller
    ↓
🎤 Twilio Converts Speech → Text
    ↓
🤖 AI Processes & Generates Response
    ↓
🔊 Twilio Converts Text → Speech
    ↓
🔄 Repeat Until Call Ends
```

## 🎯 Conversation Flow

The AI is programmed to:

1. **Greet warmly** and ask how it can help
2. **Listen actively** to the caller's needs
3. **Demonstrate capabilities** while explaining features
4. **Provide specific benefits** for their business type
5. **Share pricing transparently**:
   - Basic: $99/month
   - Pro: $299/month
   - Enterprise: Custom
6. **Collect contact info** if interested
7. **Schedule demos** or follow-ups

## 📁 Project Structure

```
ai-receptionist/
├── server.js                    # Main Express server
├── services/
│   ├── ai-service.js           # OpenAI/Anthropic integration
│   └── conversation-manager.js  # Conversation state management
├── package.json
├── .env                        # Environment variables (create this)
├── .env.example                # Example environment file
└── README.md
```

## 🔧 Customization

### Change AI Personality

Edit the system prompt in `services/ai-service.js` → `getSystemPrompt()` method.

### Modify Pricing

Update the pricing section in the system prompt.

### Change Voice

In `server.js`, modify the voice parameter:
- `Polly.Joanna` (female, US)
- `Polly.Matthew` (male, US)
- `Polly.Amy` (female, UK)
- More options: [Twilio Voices](https://www.twilio.com/docs/voice/twiml/say/text-speech#amazon-polly)

### Add Features

- **Call recording**: Add `record: 'record-from-answer'` to TwiML
- **SMS follow-up**: Use Twilio SMS API after call
- **CRM integration**: Connect to Salesforce, HubSpot, etc.
- **Analytics**: Track conversion rates and call metrics

## 📊 Monitoring

Check health endpoint:
```bash
curl https://your-domain.com/health
```

View server logs for conversation transcripts:
```bash
# Shows caller input and AI responses
npm start
```

## 💰 Cost Considerations

- **Twilio**: ~$0.013/min for voice calls
- **OpenAI GPT-4**: ~$0.03 per 1K tokens
- **Anthropic Claude**: ~$0.015 per 1K tokens
- **Estimated**: $0.05-0.10 per minute of conversation

## 🚀 Deployment Options

### Heroku
```bash
heroku create your-app-name
heroku config:set TWILIO_ACCOUNT_SID=ACxxx...
heroku config:set OPENAI_API_KEY=sk-xxx...
git push heroku main
```

### Railway
1. Connect GitHub repo
2. Add environment variables
3. Deploy automatically

### DigitalOcean App Platform
1. Create new app from GitHub
2. Configure environment variables
3. Deploy

## 🎓 Marketing Strategy

Use this AI receptionist to advertise on:

1. **Facebook Business Groups**
   - Post: "Call [number] to experience an AI receptionist demo"
   - Target: Small business owners, entrepreneurs

2. **LinkedIn**
   - Share the number in posts/comments
   - Demonstrate to decision-makers

3. **Local Business Forums**
   - Offer free trials
   - Let the AI qualify leads

## 📝 Next Steps

- [ ] Deploy to production server
- [ ] Test call quality and AI responses
- [ ] Add call recording for training
- [ ] Integrate with CRM (HubSpot, Salesforce)
- [ ] Add SMS follow-up after calls
- [ ] Implement lead scoring
- [ ] Create analytics dashboard
- [ ] A/B test different sales scripts

## 🆘 Troubleshooting

**No response from AI:**
- Check API keys in `.env`
- Verify AI provider is correct (`openai` or `anthropic`)

**Twilio not receiving calls:**
- Confirm webhook URL is publicly accessible
- Check Twilio webhook configuration
- Verify phone number is active

**Poor call quality:**
- Use enhanced speech recognition (`enhanced: true`)
- Consider ElevenLabs for better TTS
- Test different voice options

**High latency:**
- Deploy closer to Twilio servers (US East)
- Use faster AI models (GPT-3.5, Claude Haiku)
- Optimize prompt length

## 📄 License

MIT

## 🤝 Contributing

Feel free to submit issues or pull requests!

---

Built with ❤️ for automated sales demos
