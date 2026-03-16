const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Database Service - SQLite storage for leads, calls, and customers
 */
class DatabaseService {
  constructor() {
    const dbPath = path.join(__dirname, '..', 'data', 'receptionist.db');

    // Ensure data directory exists
    const fs = require('fs');
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initialize();
  }

  /**
   * Initialize database tables
   */
  initialize() {
    // Leads table - prospects who called
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT,
        email TEXT,
        company TEXT,
        business_id TEXT DEFAULT 'widescope',
        address TEXT,
        interest_level TEXT DEFAULT 'unknown',
        notes TEXT,
        status TEXT DEFAULT 'new',
        source TEXT,
        form_type TEXT,
        landing_path TEXT,
        referrer TEXT,
        page_variant TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_content TEXT,
        utm_term TEXT,
        gclid TEXT,
        fbclid TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Calls table - all call records
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        call_sid TEXT UNIQUE NOT NULL,
        lead_id TEXT,
        phone_from TEXT,
        phone_to TEXT,
        duration_seconds INTEGER DEFAULT 0,
        turn_count INTEGER DEFAULT 0,
        transcript TEXT,
        summary TEXT,
        outcome TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      )
    `);

    // Customers table - paying subscribers
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        company TEXT,
        phone TEXT,
        plan TEXT NOT NULL,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        status TEXT DEFAULT 'active',
        twilio_number TEXT,
        ai_config TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Prospect demos table - Demo Drop personalized demo pages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_demos (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        prospect_url TEXT NOT NULL,
        prospect_email TEXT,
        prospect_name TEXT,
        scraped_data TEXT,
        business_name TEXT NOT NULL,
        business_type TEXT,
        phone TEXT,
        location TEXT,
        services TEXT,
        hours TEXT,
        tagline TEXT,
        service_area TEXT,
        faqs TEXT,
        has_emergency TEXT DEFAULT 'false',
        logo_url TEXT,
        brand_color TEXT DEFAULT '#2563eb',
        system_prompt TEXT,
        demo_headline TEXT,
        demo_subheadline TEXT,
        pain_points TEXT,
        value_props TEXT,
        scrape_status TEXT DEFAULT 'pending',
        generate_status TEXT DEFAULT 'pending',
        email_status TEXT DEFAULT 'pending',
        view_count INTEGER DEFAULT 0,
        last_viewed_at TEXT,
        chat_started INTEGER DEFAULT 0,
        lead_captured INTEGER DEFAULT 0,
        converted INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Outbound calls tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_calls (
        id TEXT PRIMARY KEY,
        prospect_id TEXT,
        phone TEXT NOT NULL,
        business_name TEXT,
        call_sid TEXT,
        status TEXT DEFAULT 'initiated',
        answered_by TEXT,
        duration_seconds INTEGER DEFAULT 0,
        voicemail_left INTEGER DEFAULT 0,
        callback_received INTEGER DEFAULT 0,
        recording_url TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migration: add recording_url if missing
    try { this.db.exec('ALTER TABLE outbound_calls ADD COLUMN recording_url TEXT'); } catch (e) { /* exists */ }

    // Add columns if they don't exist (migration for existing DBs)
    try { this.db.exec('ALTER TABLE leads ADD COLUMN business_id TEXT DEFAULT "widescope"'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN address TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN source TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN form_type TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN landing_path TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN referrer TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN page_variant TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN utm_source TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN utm_medium TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN utm_campaign TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN utm_content TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN utm_term TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN gclid TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN fbclid TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE calls ADD COLUMN business_id TEXT DEFAULT "widescope"'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE calls ADD COLUMN recording_url TEXT'); } catch (e) { /* column exists */ }

    // Customers migrations
    try { this.db.exec('ALTER TABLE customers ADD COLUMN auth_token TEXT'); } catch (e) { /* column exists */ }

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
      CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers(stripe_customer_id);
      CREATE INDEX IF NOT EXISTS idx_prospect_demos_slug ON prospect_demos(slug);
      CREATE INDEX IF NOT EXISTS idx_customers_auth_token ON customers(auth_token);
      CREATE INDEX IF NOT EXISTS idx_customers_twilio_number ON customers(twilio_number);
    `);

    console.log('✅ Database initialized');
  }

  // ==================== LEAD METHODS ====================

  /**
   * Create or update a lead from phone number
   */
  createOrUpdateLead(phone, data = {}) {
    const existing = this.db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);

    if (existing) {
      const updates = [];
      const values = [];

      const fieldMap = {
        name: 'name',
        email: 'email',
        company: 'company',
        business_id: 'business_id',
        address: 'address',
        interest_level: 'interest_level',
        notes: 'notes',
        status: 'status',
        source: 'source',
        form_type: 'form_type',
        landing_path: 'landing_path',
        referrer: 'referrer',
        page_variant: 'page_variant',
        utm_source: 'utm_source',
        utm_medium: 'utm_medium',
        utm_campaign: 'utm_campaign',
        utm_content: 'utm_content',
        utm_term: 'utm_term',
        gclid: 'gclid',
        fbclid: 'fbclid'
      };

      for (const [key, column] of Object.entries(fieldMap)) {
        if (data[key]) {
          updates.push(`${column} = ?`);
          values.push(data[key]);
        }
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(phone);
        this.db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE phone = ?`).run(...values);
      }

      return this.db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
    } else {
      const id = uuidv4();
      this.db.prepare(`
        INSERT INTO leads (
          id, phone, name, email, company, business_id, address, interest_level, notes, status,
          source, form_type, landing_path, referrer, page_variant,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid, fbclid
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        phone,
        data.name || null,
        data.email || null,
        data.company || null,
        data.business_id || 'widescope',
        data.address || null,
        data.interest_level || 'unknown',
        data.notes || null,
        data.status || 'new',
        data.source || null,
        data.form_type || null,
        data.landing_path || null,
        data.referrer || null,
        data.page_variant || null,
        data.utm_source || null,
        data.utm_medium || null,
        data.utm_campaign || null,
        data.utm_content || null,
        data.utm_term || null,
        data.gclid || null,
        data.fbclid || null
      );

      return this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    }
  }

  /**
   * Get lead by phone number
   */
  getLeadByPhone(phone) {
    return this.db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
  }

  /**
   * Get all leads with optional filtering
   */
  getLeads(status = null, limit = 100) {
    if (status) {
      return this.db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
    }
    return this.db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  /**
   * Update lead status
   */
  updateLeadStatus(leadId, status) {
    this.db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, leadId);
  }

  // ==================== CALL METHODS ====================

  /**
   * Create a call record
   */
  createCall(callSid, phoneFrom, phoneTo, businessId = 'widescope') {
    const id = uuidv4();

    // Get or create lead
    const lead = this.createOrUpdateLead(phoneFrom, { business_id: businessId });

    this.db.prepare(`
      INSERT INTO calls (id, call_sid, lead_id, phone_from, phone_to, business_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, callSid, lead.id, phoneFrom, phoneTo, businessId);

    return { callId: id, leadId: lead.id };
  }

  /**
   * Update call with transcript and outcome
   */
  updateCall(callSid, data) {
    const updates = [];
    const values = [];

    if (data.duration_seconds !== undefined) { updates.push('duration_seconds = ?'); values.push(data.duration_seconds); }
    if (data.turn_count !== undefined) { updates.push('turn_count = ?'); values.push(data.turn_count); }
    if (data.transcript) { updates.push('transcript = ?'); values.push(data.transcript); }
    if (data.summary) { updates.push('summary = ?'); values.push(data.summary); }
    if (data.outcome) { updates.push('outcome = ?'); values.push(data.outcome); }
    if (data.recording_url) { updates.push('recording_url = ?'); values.push(data.recording_url); }

    if (updates.length > 0) {
      values.push(callSid);
      this.db.prepare(`UPDATE calls SET ${updates.join(', ')} WHERE call_sid = ?`).run(...values);
    }
  }

  /**
   * Get call by SID
   */
  getCallBySid(callSid) {
    return this.db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(callSid);
  }

  /**
   * Get calls for a lead
   */
  getCallsForLead(leadId) {
    return this.db.prepare('SELECT * FROM calls WHERE lead_id = ? ORDER BY created_at DESC').all(leadId);
  }

  // ==================== CUSTOMER METHODS ====================

  /**
   * Create a customer
   */
  createCustomer(data) {
    const id = uuidv4();
    const authToken = data.auth_token || uuidv4();

    this.db.prepare(`
      INSERT INTO customers (id, email, name, company, phone, plan, stripe_customer_id, stripe_subscription_id, ai_config, auth_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.email,
      data.name || null,
      data.company || null,
      data.phone || null,
      data.plan,
      data.stripe_customer_id || null,
      data.stripe_subscription_id || null,
      data.ai_config ? JSON.stringify(data.ai_config) : null,
      authToken
    );

    return this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  }

  /**
   * Get customer by email
   */
  getCustomerByEmail(email) {
    return this.db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  }

  /**
   * Get customer by Stripe customer ID
   */
  getCustomerByStripeId(stripeCustomerId) {
    return this.db.prepare('SELECT * FROM customers WHERE stripe_customer_id = ?').get(stripeCustomerId);
  }

  /**
   * Update customer subscription
   */
  updateCustomerSubscription(stripeCustomerId, subscriptionId, status) {
    this.db.prepare(`
      UPDATE customers
      SET stripe_subscription_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE stripe_customer_id = ?
    `).run(subscriptionId, status, stripeCustomerId);
  }

  /**
   * Get all active customers
   */
  getActiveCustomers() {
    return this.db.prepare("SELECT * FROM customers WHERE status = 'active'").all();
  }

  // ==================== CUSTOMER PORTAL METHODS ====================

  /**
   * Get customer by auth token
   */
  getCustomerByToken(token) {
    if (!token) return null;
    return this.db.prepare('SELECT * FROM customers WHERE auth_token = ?').get(token);
  }

  /**
   * Get customer by Twilio number (for call routing)
   */
  getCustomerByTwilioNumber(twilioNumber) {
    if (!twilioNumber) return null;
    const normalized = twilioNumber.replace(/[^+\d]/g, '');
    return this.db.prepare('SELECT * FROM customers WHERE twilio_number = ?').get(normalized);
  }

  /**
   * Get calls for a customer (by business_id = customer.id)
   */
  getCustomerCalls(customerId, limit = 50) {
    return this.db.prepare(`
      SELECT c.*, l.name as lead_name, l.phone as lead_phone
      FROM calls c
      LEFT JOIN leads l ON c.lead_id = l.id
      WHERE c.business_id = ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(customerId, limit);
  }

  /**
   * Get leads for a customer (by business_id = customer.id)
   */
  getCustomerLeads(customerId, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM leads
      WHERE business_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(customerId, limit);
  }

  /**
   * Get dashboard stats for a specific customer
   */
  getCustomerStats(customerId) {
    const totalCalls = this.db.prepare(
      'SELECT COUNT(*) as count FROM calls WHERE business_id = ?'
    ).get(customerId).count;

    const callsToday = this.db.prepare(
      "SELECT COUNT(*) as count FROM calls WHERE business_id = ? AND date(created_at) = date('now')"
    ).get(customerId).count;

    const avgDuration = this.db.prepare(
      'SELECT AVG(duration_seconds) as avg FROM calls WHERE business_id = ? AND duration_seconds > 0'
    ).get(customerId).avg || 0;

    const totalLeads = this.db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE business_id = ?'
    ).get(customerId).count;

    return { totalCalls, callsToday, avgDuration: Math.round(avgDuration), totalLeads };
  }

  /**
   * Update customer AI config and business info
   */
  updateCustomerConfig(customerId, config) {
    this.db.prepare(`
      UPDATE customers
      SET ai_config = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(config), customerId);
    return this.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  }

  /**
   * Update customer Twilio number
   */
  updateCustomerTwilioNumber(customerId, twilioNumber) {
    this.db.prepare(`
      UPDATE customers SET twilio_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(twilioNumber, customerId);
  }

  /**
   * Generate a new auth token for a customer (for magic link login)
   */
  regenerateAuthToken(customerId) {
    const token = uuidv4();
    this.db.prepare('UPDATE customers SET auth_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(token, customerId);
    return token;
  }

  // ==================== PROSPECT DEMO METHODS ====================

  /**
   * Create a new prospect demo record
   */
  createProspectDemo(data) {
    const id = data.id || uuidv4();
    this.db.prepare(`
      INSERT INTO prospect_demos (id, slug, prospect_url, prospect_email, prospect_name, business_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.slug,
      data.prospect_url,
      data.prospect_email || null,
      data.prospect_name || null,
      data.business_name || 'Unknown Business'
    );
    return this.db.prepare('SELECT * FROM prospect_demos WHERE id = ?').get(id);
  }

  /**
   * Get prospect demo by slug
   */
  getProspectDemoBySlug(slug) {
    return this.db.prepare('SELECT * FROM prospect_demos WHERE slug = ?').get(slug);
  }

  /**
   * Update prospect demo fields
   */
  updateProspectDemo(slug, data) {
    const allowed = [
      'scraped_data', 'business_name', 'business_type', 'phone', 'location',
      'services', 'hours', 'tagline', 'service_area', 'faqs', 'has_emergency',
      'logo_url', 'brand_color', 'system_prompt', 'demo_headline', 'demo_subheadline',
      'pain_points', 'value_props', 'scrape_status', 'generate_status', 'email_status',
      'view_count', 'last_viewed_at', 'chat_started', 'lead_captured', 'converted'
    ];

    const updates = [];
    const values = [];

    for (const [key, value] of Object.entries(data)) {
      if (allowed.includes(key)) {
        updates.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(slug);
      this.db.prepare(`UPDATE prospect_demos SET ${updates.join(', ')} WHERE slug = ?`).run(...values);
    }

    return this.getProspectDemoBySlug(slug);
  }

  /**
   * Increment demo view count
   */
  incrementDemoView(slug) {
    this.db.prepare(`
      UPDATE prospect_demos SET view_count = view_count + 1, last_viewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE slug = ?
    `).run(slug);
  }

  /**
   * List all prospect demos
   */
  getProspectDemos(limit = 100) {
    return this.db.prepare('SELECT * FROM prospect_demos ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ==================== STATS ====================

  /**
   * Get dashboard stats
   */
  getStats() {
    const totalLeads = this.db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
    const newLeads = this.db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'new'").get().count;
    const totalCalls = this.db.prepare('SELECT COUNT(*) as count FROM calls').get().count;
    const activeCustomers = this.db.prepare("SELECT COUNT(*) as count FROM customers WHERE status = 'active'").get().count;

    const recentLeads = this.db.prepare(`
      SELECT * FROM leads ORDER BY created_at DESC LIMIT 5
    `).all();

    const recentCalls = this.db.prepare(`
      SELECT c.*, l.phone, l.name as lead_name
      FROM calls c
      LEFT JOIN leads l ON c.lead_id = l.id
      ORDER BY c.created_at DESC LIMIT 5
    `).all();

    return {
      totalLeads,
      newLeads,
      totalCalls,
      activeCustomers,
      recentLeads,
      recentCalls
    };
  }
}

module.exports = new DatabaseService();
