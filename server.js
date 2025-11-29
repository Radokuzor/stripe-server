const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const STRIPE_MODE = (process.env.STRIPE_MODE || 'test').toLowerCase();
const STRIPE_SECRET_KEY =
    STRIPE_MODE === 'live'
        ? process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY
        : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET =
    STRIPE_MODE === 'live'
        ? process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET
        : process.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET;

if (!STRIPE_SECRET_KEY) {
    throw new Error('Stripe secret key not configured');
}

const stripe = require('stripe')(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const PRICE_MAP = {
    plus_monthly: 'price_1SYstEIUreX0PzJ7Mtkd04LM', // Basic monthly $9.99
    plus_yearly: 'price_1SYstEIUreX0PzJ7ME1DVoXg',  // Basic yearly ~$107
    pro_monthly: 'price_1SYsu9IUreX0PzJ7KM8Zw1Uj',  // Better monthly $19.99
    pro_yearly: 'price_1SYsufIUreX0PzJ7XCKOf5hC',   // Better yearly (~$215?) - confirm
    business_monthly: 'price_1SYsvyIUreX0PzJ7gfKogBNR', // Best monthly $29.99
    business_yearly: 'price_1SYsvyIUreX0PzJ7Kjfkns1k',  // Best yearly ~$334
};

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'Server is running' });
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

// Create payment intent
app.post('/create-payment-intent', async (req, res) => {
    try {
        const { amount, currency = 'usd', customerId, metadata } = req.body;

        if (!amount) {
            return res.status(400).json({ error: 'Amount is required' });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // Convert to cents
            currency,
            customer: customerId,
            metadata: metadata || {},
            automatic_payment_methods: {
                enabled: true,
            },
        });

        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
        });
    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/create-subscription', async (req, res) => {
    try {
        const { email, name, planId, billingCycle } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }

        const priceId = PRICE_MAP[`${planId}_${billingCycle}`];
        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        let customerId;
        const existing = await stripe.customers.list({ email, limit: 1 });
        if (existing.data.length) {
            customerId = existing.data[0].id;
        } else {
            const customer = await stripe.customers.create({ email, name });
            customerId = customer.id;
        }

        const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            expand: ['latest_invoice.payment_intent'],
        });

        const paymentIntent = subscription.latest_invoice.payment_intent;
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: customerId },
            { apiVersion: '2024-06-20' }
        );

        return res.json({
            subscriptionId: subscription.id,
            customerId,
            paymentIntentClientSecret: paymentIntent.client_secret,
            ephemeralKeySecret: ephemeralKey.secret,
        });
    } catch (err) {
        console.error('Create subscription error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Create customer
app.post('/create-customer', async (req, res) => {
    try {
        const { email, name, metadata } = req.body;

        const customer = await stripe.customers.create({
            email,
            name,
            metadata: metadata || {},
        });

        res.json({
            customerId: customer.id,
            customer,
        });
    } catch (error) {
        console.error('Error creating customer:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get payment intent status
app.get('/payment-intent/:id', async (req, res) => {
    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(req.params.id);
        res.json({ status: paymentIntent.status, paymentIntent });
    } catch (error) {
        console.error('Error retrieving payment intent:', error);
        res.status(500).json({ error: error.message });
    }
});

// Webhook endpoint for Stripe events
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log('PaymentIntent succeeded:', paymentIntent.id);
            // Add your business logic here
            break;
        case 'payment_intent.payment_failed':
            const failedPayment = event.data.object;
            console.log('Payment failed:', failedPayment.id);
            // Add your business logic here
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
