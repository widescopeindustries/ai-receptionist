const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 587,
  secure: false,
  auth: { user: 'sales@aialwaysanswer.com', pass: '_(H5kHC;j}e,tw}' }
});

// Parsed from Apify scrape — service businesses only, valid emails only
// Already sent: anapbm@gmail.com, david@choosemaverick.com, juanita@e-splumbingllc.com,
//               workmanplumbingdfw@gmail.com, prestigeplumbingpro@gmail.com, service@waterheaterdallastx.com
const targets = [
  { name: 'Team',    business: 'IMS Home Remodeling & Plumbing',      email: 'ContactUs@imsremodeling.plumbing',       industry: 'plumbing' },
  { name: 'Team',    business: 'Antonios Excavation',                  email: 'antonios.excavation1084@gmail.com',      industry: 'contractor' },
  { name: 'Team',    business: 'My Texas Home Services',               email: 'contact@mytexashomeservicesdfw.com',     industry: 'hvac' },
  { name: 'Team',    business: 'Hernandez Cleaning and Restoration',   email: 'contactus@hernandezcleanrest.com',       industry: 'contractor' },
  { name: 'Paladio', business: 'Rubric Plumbing',                      email: 'paladio@rubricplumbing.com',             industry: 'plumbing' },
  { name: 'Team',    business: 'Dalton Water Heater Dallas',           email: 'service@dallaswaterheater.repair',       industry: 'plumbing' },
  { name: 'Eric',    business: 'E & S Plumbing LLC',                   email: 'eric@e-splumbingllc.com',                industry: 'plumbing' },
  { name: 'Team',    business: 'Z Plumberz of North Dallas',           email: 'northdallas@zplumberz.com',              industry: 'plumbing' },
  { name: 'Team',    business: 'Chavarria Plumbing Services',          email: 'ChavarriaPlumbingServices@gmail.com',    industry: 'plumbing' },
  { name: 'Team',    business: 'Metro Flow Plumbing',                  email: 'metroflow@metroflowplumbing.com',        industry: 'plumbing' },
  { name: 'Team',    business: 'All Masters Plumbing',                 email: 'careers@allmasters.co',                  industry: 'plumbing' },
  { name: 'Team',    business: 'Harlen Johnson HVAC & Plumbing',       email: 'info@hjac.com',                          industry: 'hvac' },
];

const hooks = {
  plumbing:   "When someone has a burst pipe at midnight, the first plumber who answers gets the job.",
  hvac:       "When someone's AC dies in July, the first HVAC company who answers gets the call.",
  contractor: "When a customer needs an urgent repair, the first contractor who answers gets the work.",
};

function buildEmail(t) {
  const hook = hooks[t.industry] || hooks.plumbing;
  const subject = t.name !== 'Team'
    ? `${t.name} — is ${t.business} answering after hours?`
    : `Is ${t.business} answering after hours?`;

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.7">
<p>Hi ${t.name},</p>
<p>${hook}</p>
<p>Is that you — or your voicemail?</p>
<p>We built an AI receptionist that answers every call instantly, 24/7, books appointments, and texts you the lead details. <strong>$99/month.</strong> Sounds like a real person.</p>
<p>Don't take my word for it — <strong>call this number right now and hear it live:</strong></p>
<p style="text-align:center;margin:28px 0">
  <a href="tel:8175338424" style="background:#2563eb;color:white;font-size:22px;font-weight:bold;padding:14px 36px;border-radius:8px;text-decoration:none;display:inline-block">
    📞 (817) 533-8424
  </a>
</p>
<p>That AI just answered your call. It can do the same for <em>${t.business}</em> starting tonight.</p>
<p>14-day money-back guarantee. No contracts. Live in under an hour.</p>
<p><a href="https://aialwaysanswer.com?ref=email" style="color:#2563eb">See how it works →</a></p>
<p style="margin-top:32px;color:#888;font-size:13px">
  — Lyndon<br>
  AI Always Answer<br>
  <a href="mailto:sales@aialwaysanswer.com" style="color:#888">sales@aialwaysanswer.com</a><br><br>
  <a href="mailto:sales@aialwaysanswer.com?subject=Unsubscribe" style="color:#bbb;font-size:12px">Unsubscribe</a>
</p>
</body>
</html>`;

  const text = `Hi ${t.name},

${hook}

Is that you — or your voicemail?

We built an AI receptionist that answers every call instantly, 24/7, books appointments, and texts you the lead details. $99/month. Sounds like a real person.

Call this number right now and hear it live: (817) 533-8424

That AI just answered your call. It can do the same for ${t.business} starting tonight.

14-day money-back guarantee. No contracts. Live in under an hour.

https://aialwaysanswer.com

— Lyndon
AI Always Answer
sales@aialwaysanswer.com

To unsubscribe, reply with "unsubscribe"`;

  return { subject, html, text };
}

async function send() {
  console.log(`Sending to ${targets.length} targets...\n`);
  let sent = 0, failed = 0;

  for (const t of targets) {
    const { subject, html, text } = buildEmail(t);
    try {
      await transporter.sendMail({
        from: '"AI Always Answer" <sales@aialwaysanswer.com>',
        to: t.email,
        subject,
        html,
        text,
      });
      console.log(`✅ SENT → ${t.email} (${t.business})`);
      sent++;
    } catch (e) {
      console.log(`❌ FAIL → ${t.email}: ${e.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`\nDone. ${sent} sent, ${failed} failed.`);
}

send();
