const Stripe = require('stripe');
const db = require('./database');

/**
 * Stripe Service - Payment processing for AI Receptionist subscriptions
 */
class StripeService {
  constructor() {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.warn('⚠️  STRIPE_SECRET_KEY not set - payments disabled');
      this.stripe = null;
      return;
    }

    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
  }

  /**
   * Pricing configuration
   */
  static PLANS = {
    basic: {
      name: 'Basic Plan',
      price: 9900, // $99.00 in cents
      priceId: process.env.STRIPE_BASIC_PRICE_ID,
      features: [
        '500 minutes/month',
        'Basic AI receptionist',
        'Call transcripts',
        'Email notifications',
        'Business hours only'
      ]
    },
    pro: {
      name: 'Pro Plan',
      price: 29900, // $299.00 in cents
      priceId: process.env.STRIPE_PRO_PRICE_ID,
      features: [
        '2,000 minutes/month',
        'Advanced AI with memory',
        'CRM integration',
        'Custom voice & personality',
        '24/7 availability',
        'Priority support'
      ]
    },
    enterprise: {
      name: 'Enterprise',
      price: null, // Custom pricing
      priceId: null,
      features: [
        'Unlimited minutes',
        'Multiple phone lines',
        'Custom integrations',
        'Dedicated support',
        'White-label option',
        'SLA guarantee'
      ]
    }
  };

  /**
   * Check if Stripe is configured
   */
  isConfigured() {
    return this.stripe !== null;
  }

  /**
   * Create a checkout session for subscription
   */
  async createCheckoutSession(plan, customerEmail, successUrl, cancelUrl) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    const planConfig = StripeService.PLANS[plan];
    if (!planConfig || !planConfig.priceId) {
      throw new Error(`Invalid plan: ${plan}`);
    }

    // Check if customer already exists
    const existingCustomers = await this.stripe.customers.list({
      email: customerEmail,
      limit: 1
    });

    let customerId;
    if (existingCustomers.data.length > 0) {
      customerId = existingCustomers.data[0].id;
    }

    const sessionConfig = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: planConfig.priceId,
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerId ? undefined : customerEmail,
      customer: customerId || undefined,
      metadata: {
        plan: plan
      },
      subscription_data: {
        metadata: {
          plan: plan
        }
      },
      allow_promotion_codes: true
    };

    const session = await this.stripe.checkout.sessions.create(sessionConfig);
    return session;
  }

  /**
   * Create a payment link for a plan (one-time setup)
   */
  async createPaymentLink(plan) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    const planConfig = StripeService.PLANS[plan];
    if (!planConfig || !planConfig.priceId) {
      throw new Error(`Invalid plan: ${plan}`);
    }

    const paymentLink = await this.stripe.paymentLinks.create({
      line_items: [{
        price: planConfig.priceId,
        quantity: 1
      }],
      metadata: {
        plan: plan
      },
      after_completion: {
        type: 'redirect',
        redirect: {
          url: `${process.env.BASE_URL}/onboarding?plan=${plan}`
        }
      }
    });

    return paymentLink;
  }

  /**
   * Handle webhook events from Stripe
   */
  async handleWebhook(event) {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutComplete(event.data.object);
        break;

      case 'customer.subscription.created':
        await this.handleSubscriptionCreated(event.data.object);
        break;

      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.paid':
        console.log(`💰 Invoice paid: ${event.data.object.id}`);
        break;

      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  }

  /**
   * Handle successful checkout
   */
  async handleCheckoutComplete(session) {
    console.log('🎉 Checkout completed:', session.id);

    const customerEmail = session.customer_email || session.customer_details?.email;
    const plan = session.metadata?.plan || 'basic';

    // Get Stripe customer
    const customer = await this.stripe.customers.retrieve(session.customer);

    // Create customer in our database
    const dbCustomer = db.createCustomer({
      email: customerEmail,
      name: customer.name || session.customer_details?.name,
      phone: customer.phone || session.customer_details?.phone,
      plan: plan,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription
    });

    console.log(`✅ Customer created: ${dbCustomer.email} on ${plan} plan`);

    return dbCustomer;
  }

  /**
   * Handle subscription created
   */
  async handleSubscriptionCreated(subscription) {
    console.log('📦 Subscription created:', subscription.id);

    db.updateCustomerSubscription(
      subscription.customer,
      subscription.id,
      subscription.status
    );
  }

  /**
   * Handle subscription updated
   */
  async handleSubscriptionUpdated(subscription) {
    console.log('🔄 Subscription updated:', subscription.id);

    db.updateCustomerSubscription(
      subscription.customer,
      subscription.id,
      subscription.status
    );
  }

  /**
   * Handle subscription deleted/cancelled
   */
  async handleSubscriptionDeleted(subscription) {
    console.log('❌ Subscription cancelled:', subscription.id);

    db.updateCustomerSubscription(
      subscription.customer,
      subscription.id,
      'cancelled'
    );
  }

  /**
   * Handle failed payment
   */
  async handlePaymentFailed(invoice) {
    console.log('⚠️ Payment failed for:', invoice.customer_email);
    // TODO: Send email notification about failed payment
  }

  /**
   * Get customer's subscription status
   */
  async getSubscriptionStatus(stripeCustomerId) {
    if (!this.stripe) {
      return null;
    }

    const subscriptions = await this.stripe.subscriptions.list({
      customer: stripeCustomerId,
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      return null;
    }

    return subscriptions.data[0];
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(subscriptionId) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    return await this.stripe.subscriptions.cancel(subscriptionId);
  }

  /**
   * Create a customer portal session
   */
  async createPortalSession(stripeCustomerId, returnUrl) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl
    });

    return session;
  }

  /**
   * Construct webhook event from request
   */
  constructWebhookEvent(payload, signature) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  }
}

module.exports = new StripeService();
