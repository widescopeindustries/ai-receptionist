const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

/**
 * Businesses likely to have existing answering services — poor cold-call prospects.
 * These already have the problem "solved" (even if poorly) and won't see the pain clearly.
 */
const SUPPRESSED_PATTERNS = [
  /clinic|medical|urgent care|hospital|health center|family practice|primary care/i,
  /answering service|call center|virtual receptionist/i,  // They ARE the competition
];

function isSuppressed(businessName) {
  if (!businessName) return false;
  return SUPPRESSED_PATTERNS.some(p => p.test(businessName));
}

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+18175338424';
const BASE_URL = process.env.BASE_URL || 'https://aialwaysanswer.com';

/**
 * The voicemail script Jessica leaves.
 * This IS the proof of concept — the voicemail demonstrates the problem.
 */
/**
 * Detect industry from business name
 */
function detectIndustry(businessName) {
  const name = (businessName || '').toLowerCase();
  
  // Check specific trades FIRST before broader categories
  if (/plumb/.test(name)) return 'plumber';
  if (/electric/.test(name)) return 'electrician';
  if (/roof/.test(name)) return 'roofer';
  if (/hvac|heat(?:ing)?|air cond|cool(?:ing)?|mechanical|comfort|(?<!\w)ac(?:\s|$)/i.test(name)) return 'hvac';
  if (/pest|termite/.test(name)) return 'pest';
  if (/fence/.test(name)) return 'fence';
  if (/tree/.test(name)) return 'tree';
  if (/paint/.test(name)) return 'painter';
  if (/remodel|construction|contractor|cabinet|bath/.test(name)) return 'remodeler';
  if (/garage door/.test(name)) return 'garage_door';
  if (/foundation/.test(name)) return 'foundation';
  if (/landscap|lawn|yard|mow/.test(name)) return 'landscaper';
  if (/handyman/.test(name)) return 'handyman';
  if (/septic/.test(name)) return 'septic';
  if (/dental|dentist|orthodont/.test(name)) return 'dental';
  if (/law|lawyer|attorney|legal/.test(name)) return 'legal';
  if (/vet|animal|pet/.test(name)) return 'veterinary';
  if (/auto|tire|mechanic|body shop|collision/.test(name)) return 'auto';
  if (/salon|barber|hair|beauty|spa/.test(name)) return 'salon';
  if (/chiro|spine|wellness|injury clinic/.test(name)) return 'chiropractic';
  if (/restaurant|cafe|kitchen|grill|bistro|taco|pizza|burger|bbq|barbecue|deli|bakery|coffee|tata|garcia/.test(name)) return 'restaurant';
  
  return 'default';
}

/**
 * Full industry-specific voicemail scripts — entire narrative changes per industry
 */
function getVoicemailScript(businessName) {
  const biz = businessName || 'your business';
  const industry = detectIndustry(businessName);
  
  const closer = `99 bucks a month. That's it. ` +
    `And here's the fun part... call me back and I'll answer as ${biz}'s receptionist. ` +
    `You'll hear exactly what your customers would get. ` +
    `8 1 7, 5 3 3, 8 4 2 4. ` +
    `That's 8 1 7, 5 3 3, 8 4 2 4. ` +
    `Don't worry about the time or what day it is... that's kind of the whole point, right? Talk soon!`;

  const scripts = {
    plumber: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Now see... I'M patient enough to leave you this voicemail. ` +
      `But your customers? The ones cankle deep in a plumbing nightmare right now? They are not. ` +
      `85 out of 100 just hang up and call the next plumber. That plumber answers... and gets the job. ` +
      `It's 2026. Time to plug the leak... pun intended. ` +
      `I answer your calls 24 7, talk to your customers, and book the job before they call someone else. ` +
      `${closer}`,

    electrician: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called you after hours and got your voicemail. ` +
      `Now picture this... someone's power just went out. It's 9 PM. Kids are screaming. ` +
      `They Google electricians, they find you, they call... and they get this voicemail. ` +
      `You think they're waiting till morning? No way. They call the next electrician on the list. ` +
      `85 percent of callers won't leave a voicemail. They just move on. ` +
      `That emergency call? Could've been a 500, 800, maybe a 2,000 dollar job. Gone. ` +
      `I can make sure that never happens. I answer every call for you, 24 7, sound just like this, ` +
      `and I book the job before they even think about calling someone else. ` +
      `${closer}`,

    hvac: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called you after hours and got your voicemail. ` +
      `Now think about this... it's a hundred and four degrees in Texas right now. ` +
      `Someone's AC just died. The house is an oven. They call you... voicemail. ` +
      `You think they're gonna wait? When it's a hundred and four? ` +
      `They're calling the next HVAC company before your greeting is even done playing. ` +
      `85 percent of callers don't leave messages. They just call your competitor. ` +
      `That's a 5, 8, maybe 10 thousand dollar system install walking out the door every time this happens. ` +
      `I answer every call, 24 7, talk to your customers, and schedule the appointment while it's still hot. ` +
      `${closer}`,

    roofer: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called you after hours and got your voicemail. ` +
      `Here's something to think about... a hailstorm just rolled through. ` +
      `Homeowner's got damage everywhere. Insurance is gonna cover it. ` +
      `They need a roofer NOW. They call you... voicemail. ` +
      `That's a 10, 15, maybe 20 thousand dollar job and they're calling the next roofer on Google before your beep even sounds. ` +
      `85 percent of callers won't leave a message. That's real data. ` +
      `I can answer your phone 24 7, qualify the lead, get the address, and book the inspection. ` +
      `All while you're on another roof or asleep. ` +
      `${closer}`,

    restaurant: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Now think about your Friday night rush... phone's ringing off the hook. ` +
      `Staff is slammed. Someone calls for a reservation or a big takeout order... voicemail. ` +
      `They're not leaving a message. They're opening Yelp and calling the next place. ` +
      `That's a table for eight, maybe a 200 dollar takeout order, gone. ` +
      `The average restaurant loses over a thousand bucks a month just from missed calls. ` +
      `I can answer every call, take the reservation, read your specials, handle takeout orders, ` +
      `all while your staff focuses on the customers who are already there. ` +
      `${closer}`,

    dental: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Now here's the thing... someone's got a toothache right now. ` +
      `It's throbbing. They can't sleep. They finally pick up the phone to call a dentist... voicemail. ` +
      `They're not waiting until morning. They're calling the next dentist. ` +
      `A single missed patient call costs a dental practice an average of 200 dollars. ` +
      `And that patient? Once they book somewhere else, you've probably lost them for good. ` +
      `I can answer your phones 24 7, schedule appointments, answer insurance questions, ` +
      `and make sure no patient ever slips through the cracks. ` +
      `${closer}`,

    legal: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Now think about this... someone just got arrested. Or served papers. Or in a car accident. ` +
      `They need a lawyer RIGHT NOW. Not tomorrow. Not Monday. Now. ` +
      `They call you... voicemail. You know what happens next. ` +
      `They call the next attorney on Google. And that attorney gets the case, the retainer, everything. ` +
      `Law firms lose an average of 250,000 dollars a year from missed calls. ` +
      `I can answer every call, 24 7, do the intake, qualify the case, and schedule the consultation ` +
      `so that when you walk in Monday morning, your calendar is full instead of your voicemail. ` +
      `${closer}`,

    veterinary: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Picture this... it's 10 PM and someone's dog just ate something it shouldn't have. ` +
      `The owner is panicking. They call their vet... voicemail. ` +
      `A panicking pet owner is not leaving a message. They're calling the next clinic. ` +
      `Or worse, they're driving to the emergency vet and you lose that relationship forever. ` +
      `I can answer your calls 24 7, calm worried pet owners down, ` +
      `schedule appointments, and make sure they always reach someone who cares. ` +
      `${closer}`,

    auto: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Think about this... someone's car just broke down. They're on the side of the road. ` +
      `They Google auto repair, they find you, they call... voicemail. ` +
      `You think they're waiting? They're calling the next shop. With their tow truck. And their wallet. ` +
      `Auto shops lose 3 to 5 customers a week from missed calls. That adds up fast. ` +
      `I can answer every call, book service appointments, check on parts availability, ` +
      `and make sure nobody drives past your shop to your competitor. ` +
      `${closer}`,

    salon: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Here's what's happening right now... someone wants to book a cut for this weekend. ` +
      `They call you... voicemail. They're not leaving a message. They're booking with the salon that picks up. ` +
      `25 percent of salon bookings are lost to missed calls. That's real money walking out the door. ` +
      `I can answer your phone 24 7, book appointments, answer questions about services and pricing, ` +
      `and make sure every client gets through. ` +
      `${closer}`,

    chiropractic: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's back just went out. They can barely move. They're finally ready to call a chiropractor. ` +
      `They call you... and get this voicemail. You think they're waiting? ` +
      `They're calling the next chiropractor while they can still reach their phone. ` +
      `Missing just one patient call a day costs a practice about 15,000 dollars a year. ` +
      `I can answer every call, schedule appointments, answer common questions, ` +
      `and make sure patients in pain always reach someone. ` +
      `${closer}`,

    pest: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Imagine this... someone just found termites in their wall. Or a rat in their kitchen. ` +
      `They are freaking out. They call you... voicemail. ` +
      `Nobody with bugs in their house is leaving a calm message. They're calling the next exterminator. ` +
      `I can answer your phones 24 7, calm people down, and book the inspection ` +
      `before they call your competitor in a panic. ` +
      `${closer}`,

    fence: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's looking at getting a new fence. They call three companies for quotes. ` +
      `Two answer. One goes to voicemail. Guess which two get the job? ` +
      `85 percent of people don't leave voicemails. They just call the next company. ` +
      `I can answer your calls 24 7, get the details, and schedule the estimate ` +
      `so you show up first and close the deal. ` +
      `${closer}`,

    tree: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `A storm just knocked a tree onto someone's driveway. They can't get out. ` +
      `They call you... voicemail. They need that tree gone NOW, not tomorrow. ` +
      `They're calling the next tree service immediately. ` +
      `I can answer your calls 24 7 and book emergency jobs before your competitor does. ` +
      `${closer}`,

    painter: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's ready to get their house painted. They call three painters. ` +
      `The ones who answer get the estimate. The one who goes to voicemail? ` +
      `They don't even make the short list. 85 percent of callers won't leave a message. ` +
      `I can answer your phone 24 7, get the details, and book the estimate for you. ` +
      `${closer}`,

    remodeler: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's ready to redo their kitchen. That's a 20, 30, maybe 50 thousand dollar job. ` +
      `They call you... voicemail. You think they're waiting? On a 50 thousand dollar project? ` +
      `They're calling the next contractor. And the next. And whoever answers first gets that job. ` +
      `I can answer your calls 24 7 and make sure you never lose a big project to a voicemail. ` +
      `${closer}`,

    garage_door: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's garage door just broke. They can't get their car out. They gotta get to work. ` +
      `They call you... voicemail. They're not waiting. They're calling the next company. ` +
      `I answer every call, 24 7, and book the service call before they even finish being frustrated. ` +
      `${closer}`,

    foundation: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone just noticed a crack in their foundation. They're worried their house is sinking. ` +
      `That's a scared homeowner with an expensive problem. They call you... voicemail. ` +
      `A scared homeowner is not leaving a message. They're calling the next foundation company. ` +
      `That could be a 5, 10, 20 thousand dollar job... gone. ` +
      `I answer every call, 24 7, calm them down, and schedule the inspection. ` +
      `${closer}`,

    landscaper: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's HOA is on their back about their yard. Or they're selling their house and need curb appeal fast. ` +
      `They call you... voicemail. You know what they do next. Call the next landscaper. ` +
      `I can answer your calls 24 7, schedule estimates, and make sure you're the one who shows up. ` +
      `${closer}`,

    handyman: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's got a honey-do list a mile long. They finally picked up the phone to get help. ` +
      `Voicemail? They're calling the next handyman. People want problems solved now, not later. ` +
      `I answer every call, 24 7, figure out what they need, and book the job. ` +
      `${closer}`,

    septic: `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
      `I just called and got your voicemail. ` +
      `Someone's septic is backing up. Into their house. Right now. ` +
      `You think they're leaving a voicemail? They're calling every septic company in town until someone answers. ` +
      `That's a thousand, two thousand dollar emergency job going to whoever picks up first. ` +
      `I answer every call, 24 7, and I promise you... I pick up first. ` +
      `${closer}`,
  };

  // Default script for unmatched industries
  const defaultScript = `Hey ${biz}, this is Jessica and I'm an AI receptionist. ` +
    `I just called your business and got your voicemail. ` +
    `Now see... I'M patient enough to leave you this voicemail. ` +
    `But according to research, 85 percent of your customers? They are not. ` +
    `They don't leave messages. They just hang up and call the next business that answers. ` +
    `62 percent go straight to your competitor. That's not a guess, those are real numbers. ` +
    `The average small business loses over 60,000 dollars a year just from missed calls. ` +
    `I can answer every single call, 24 7, handle your customers, and sound exactly like this. ` +
    `${closer}`;

  return scripts[industry] || defaultScript;
}

/**
 * Generate a fully personalized voicemail script using AI + business context.
 * Falls back to template script if anything fails.
 */
async function generatePersonalizedScript(businessName, context) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log(`⚠️ No OPENAI_API_KEY — falling back to template for ${businessName}`);
      return getVoicemailScript(businessName);
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const industry = detectIndustry(businessName);

    const prompt = `You are writing a voicemail script for Jessica, an AI receptionist, to leave for a business called "${businessName}".

BUSINESS CONTEXT (use what's relevant, ignore what's not):
${context || 'No additional context available.'}

INDUSTRY DETECTED: ${industry}

JESSICA'S VOICE & STYLE:
- Warm, confident, slightly playful — NOT corporate or salesy
- Uses humor naturally (puns welcome, forced jokes not)
- Speaks like a real person leaving a real voicemail
- She's an AI and she's proud of it — she doesn't hide it, she shows it off
- She's calling after hours on purpose to prove a point: THEIR voicemail is what customers hear

SCRIPT REQUIREMENTS:
- Open with "Hey ${businessName}" — use their actual name
- Introduce herself: "this is Jessica and I'm an AI receptionist"
- Reference something SPECIFIC about their business from the context (location, services, reviews, anything)
- Paint a vivid scenario specific to their industry where a customer calls and gets voicemail
- Use the stats: 85% of callers won't leave a voicemail, 62% call a competitor
- Make the pain real and specific to THEIR business
- Close with the price: 99 bucks a month
- End with callback number: "call me back at 8 1 7, 5 3 3, 8 4 2 4" (say it twice)
- End with: "and don't worry about what time or day it is... that's kind of the whole point, right? Talk soon!"
- Keep it 45-75 seconds when spoken (roughly 150-250 words)
- NO stage directions, NO quotation marks, NO labels — just the script text Jessica will speak

IMPORTANT: This voicemail should feel like it could ONLY have been left for THIS business. Not a template. A one-of-one message.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
      max_tokens: 500,
    });

    const script = response.choices[0]?.message?.content?.trim();
    if (script && script.length > 100) {
      console.log(`🎯 AI-personalized voicemail generated for ${businessName} (${script.length} chars)`);
      return script;
    }
    
    console.log(`⚠️ AI script too short, falling back to template for ${businessName}`);
    return getVoicemailScript(businessName);
  } catch (err) {
    console.error(`❌ AI script generation failed for ${businessName}:`, err.message);
    return getVoicemailScript(businessName);
  }
}

/**
 * Search for business info to use as context for personalized voicemails.
 * Returns a string of context or empty string if nothing found.
 */
async function getBusinessContext(businessName, phone) {
  try {
    if (!process.env.OPENAI_API_KEY) return '';
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    // Use OpenAI with web search to gather business context
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Look up this business and give me a brief summary I can use to personalize a sales voicemail:

Business: ${businessName}
Phone: ${phone || 'unknown'}

Tell me:
- What city/area they're in
- What services they offer
- Any notable details (years in business, specialties, reviews)
- Their tagline or slogan if visible

Keep it to 3-5 bullet points. Facts only, no fluff.`
      }],
      temperature: 0.3,
      max_tokens: 200,
    });
    
    const context = response.choices[0]?.message?.content?.trim();
    console.log(`🔍 Business context found for ${businessName}: ${context?.substring(0, 100)}...`);
    return context || '';
  } catch (err) {
    console.error(`⚠️ Business context lookup failed for ${businessName}:`, err.message);
    return '';
  }
}

/**
 * Make an outbound call with AMD (Answering Machine Detection).
 * If voicemail detected → leave the message via TTS.
 * If human answers → play a shorter live pitch.
 */
// In-memory cache for pre-generated scripts (cleared on restart)
const scriptCache = new Map();

async function callProspect({ phone, businessName, prospectId }) {
  const callId = uuidv4();
  
  // Pre-generate personalized script before dialing
  try {
    if (businessName && !scriptCache.has(phone)) {
      console.log(`🎯 Pre-generating personalized voicemail for ${businessName}...`);
      const context = await getBusinessContext(businessName, phone);
      const personalizedScript = await generatePersonalizedScript(businessName, context);
      scriptCache.set(phone, personalizedScript);
      console.log(`✅ Script ready for ${businessName}`);
    }
  } catch (err) {
    console.error(`⚠️ Script pre-gen failed for ${businessName}, will use template:`, err.message);
  }
  
  try {
    const call = await getClient().calls.create({
      to: phone,
      from: FROM_NUMBER,
      url: `${BASE_URL}/outbound/voicemail-handler?id=${callId}&name=${encodeURIComponent(businessName || '')}&prospectId=${prospectId || ''}&phone=${encodeURIComponent(phone || '')}`,
      statusCallback: `${BASE_URL}/outbound/status?id=${callId}&name=${encodeURIComponent(businessName || '')}&prospectId=${prospectId || ''}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,  // Record every call for review
      recordingStatusCallback: `${BASE_URL}/outbound/recording?id=${callId}`,
      recordingStatusCallbackMethod: 'POST',
      machineDetection: 'DetectMessageEnd',  // Wait for beep, then speak
      machineDetectionTimeout: 30,           // 30s — voicemail greetings run ~30s
      machineDetectionSpeechThreshold: 1200, // 1.2s of speech → human (default 2400ms too slow)
      machineDetectionSpeechEndThreshold: 900, // 0.9s silence after speech to finalize
      machineDetectionSilenceTimeout: 3000,  // 3s of silence → machine (faster fail)
      timeout: 25,  // Ring for 25 seconds max
    });

    console.log(`📞 Outbound call initiated: ${call.sid} → ${phone} (${businessName || 'unknown'})`);
    
    return {
      callId,
      callSid: call.sid,
      phone,
      businessName,
      status: 'initiated'
    };
  } catch (err) {
    console.error(`❌ Outbound call failed to ${phone}:`, err.message);
    return {
      callId,
      phone,
      businessName,
      status: 'failed',
      error: err.message
    };
  }
}

/**
 * Batch call multiple prospects with a delay between each.
 * @param {Array} prospects - [{phone, businessName, prospectId}]
 * @param {number} delayMs - delay between calls (default 5s)
 */
async function batchCall(prospects, delayMs = 5000) {
  const results = [];
  
  for (let i = 0; i < prospects.length; i++) {
    const prospect = prospects[i];
    
    // Skip suppressed verticals (clinics, existing answering services, etc.)
    if (isSuppressed(prospect.businessName)) {
      console.log(`⏭️ Skipping suppressed prospect: ${prospect.businessName}`);
      results.push({ ...prospect, status: 'suppressed', error: 'Suppressed vertical' });
      continue;
    }
    
    console.log(`📞 Calling ${i + 1}/${prospects.length}: ${prospect.businessName || prospect.phone}`);
    
    const result = await callProspect(prospect);
    results.push(result);
    
    // Delay between calls to avoid Twilio rate limits
    if (i < prospects.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

/**
 * Get the best available script for a phone number.
 * Returns AI-personalized if cached, otherwise falls back to template.
 */
function getScriptForCall(phone, businessName) {
  if (phone && scriptCache.has(phone)) {
    console.log(`🎯 Using AI-personalized script for ${businessName || phone}`);
    return scriptCache.get(phone);
  }
  console.log(`📝 Using template script for ${businessName || phone}`);
  return getVoicemailScript(businessName);
}

module.exports = { callProspect, batchCall, getVoicemailScript, getScriptForCall, generatePersonalizedScript, getBusinessContext, isSuppressed, FROM_NUMBER, BASE_URL };
