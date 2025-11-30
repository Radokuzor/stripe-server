const express = require('express');
const cors = require('cors');
require('dotenv').config();
const OpenAI = require('openai');

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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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

const fallbackAiResponse = (metadata = {}, folders = []) => {
    const cleanFolders = (Array.isArray(folders) ? folders : [])
        .map((f) => (f || '').trim())
        .filter(Boolean);

    const suggestedFolders = cleanFolders.length ? [cleanFolders[0]] : ['General'];

    return {
        title: metadata.title || 'Content',
        description: metadata.description || 'Description',
        tags: metadata.tags || ['tag1', 'tag2'],
        suggestedFolders,
        category: suggestedFolders[0] || 'General',
    };
};

app.post('/ai/analyze', async (req, res) => {
    const {
        type = 'url',
        url,
        metadata = {},
        imageBase64,
        currentFolders,
        preferredFolders,
    } = req.body || {};

    try {
        if (!openaiClient) {
            return res.json(fallbackAiResponse(metadata, currentFolders || preferredFolders || []));
        }

        const incomingFolders = currentFolders ?? preferredFolders ?? [];
        const cleanFolders = (Array.isArray(incomingFolders) ? incomingFolders : [])
            .map((f) => (f || '').trim())
            .filter(Boolean);
        const foldersList = cleanFolders.join(', ');
        console.log('AI analyze incoming:', {
            type,
            url,
            metadata,
            currentFolders: cleanFolders,
            hasImage: Boolean(imageBase64),
            assistant: OPENAI_ASSISTANT_ID || null,
        });

        const userText = [
            `Type: ${type}`,
            url ? `URL: ${url}` : null,
            metadata?.title ? `Title: ${metadata.title}` : null,
            metadata?.description ? `Description: ${metadata.description}` : null,
            metadata?.keywords ? `Keywords: ${metadata.keywords}` : null,
            foldersList ? `Existing folders: ${foldersList}` : null,
        ]
            .filter(Boolean)
            .join('\n');

        const userContent = [
            { type: 'text', text: userText || 'Analyze this content.' },
            ...(imageBase64
                ? [{ type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` }]
                : []),
        ];
        console.log('AI analyze prompt to model:', { userContent });

        let raw;

        if (OPENAI_ASSISTANT_ID) {
            console.log('AI analyze using assistant:', OPENAI_ASSISTANT_ID);

            // Create a thread
            const thread = await openaiClient.beta.threads.create();

            // Add message to thread
            await openaiClient.beta.threads.messages.create(thread.id, {
                role: 'user',
                content: userContent
            });

            // Run the assistant
            const run = await openaiClient.beta.threads.runs.create(thread.id, {
                assistant_id: OPENAI_ASSISTANT_ID,
            });

            // Wait for completion
            let runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);
            while (runStatus.status !== 'completed') {
                await new Promise(resolve => setTimeout(resolve, 1000));
                runStatus = await openaiClient.beta.threads.runs.retrieve(thread.id, run.id);

                if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
                    throw new Error(`Run ${runStatus.status}`);
                }
            }

            // Get messages
            const messages = await openaiClient.beta.threads.messages.list(thread.id);
            raw = messages.data[0].content[0].text.value;

            console.log('AI analyze assistant raw output:', raw);
        } else {
            const basePrompt =
                'You categorize and tag user content. Respond ONLY with JSON containing: ' +
                'title (7-12 words, specific, rewritten; do not just shorten), ' +
                'description (2-3 sentences; expand with key entities/keywords for search), ' +
                'tags (3-8 short keyword strings), suggestedFolders (single-word strings, lowercase or snake_case; ' +
                'reuse the closest match from provided folders; only create a new one if none clearly fit), ' +
                'category (one word; the single most specific concept, prefer an existing folder if relevant). ' +
                'Avoid placeholders. Keep safe for general audiences.';

            const messages = [
                {
                    role: 'system',
                    content: basePrompt,
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: userText || 'Analyze this content.' },
                        ...(imageBase64
                            ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }]
                            : []),
                    ],
                },
            ];

            const completion = await openaiClient.chat.completions.create({
                model: OPENAI_MODEL,
                temperature: 0.3,
                response_format: { type: 'json_object' },
                messages,
            });

            raw = completion?.choices?.[0]?.message?.content;
            console.log('AI analyze chat raw output:', raw);
        }

        const parsed = raw ? JSON.parse(raw) : null;
        console.log('AI analyze parsed JSON:', parsed);

        return res.json(parsed || fallbackAiResponse(metadata, cleanFolders));
    } catch (err) {
        console.error('AI analyze error:', err);
        return res.status(500).json({ error: 'AI analysis failed', fallback: fallbackAiResponse(metadata, currentFolders || preferredFolders || []) });
    }
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
