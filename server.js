const express = require('express');
const cors = require('cors');
require('dotenv').config();
const OpenAI = require('openai');
const { verifyToken, clerkClient } = require('@clerk/clerk-sdk-node');
const admin = require('firebase-admin');

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

const getFirebaseConfig = () => {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (parsed.private_key) {
            parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
        }
        return parsed;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (projectId && clientEmail && privateKey) {
        return {
            project_id: projectId,
            client_email: clientEmail,
            private_key: privateKey,
        };
    }
    return null;
};

const firebaseConfig = getFirebaseConfig();
if (!firebaseConfig) {
    console.warn('Firebase config not fully set. Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.');
}

if (firebaseConfig && !admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig),
    });
}

const firestore = admin.apps.length ? admin.firestore() : null;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const stripe = require('stripe')(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const parsePriceMap = (value, fallback) => {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
};

const PRICE_MAP =
    STRIPE_MODE === 'live'
        ? parsePriceMap(process.env.PRICE_MAP_LIVE, null)
        : parsePriceMap(process.env.PRICE_MAP_TEST, null);

if (!PRICE_MAP) {
    throw new Error('Stripe price map not configured. Set PRICE_MAP_TEST/PRICE_MAP_LIVE JSON in env.');
}

const extractBearer = (req) => {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
    return null;
};

const requireClerkAuth = async (req, res, next) => {
    try {
        const token = extractBearer(req);
        if (!token) {
            return res.status(401).json({ error: 'Missing Authorization bearer token' });
        }
        const session = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
        const clerkUserId = session.sub;
        if (!clerkUserId) {
            return res.status(401).json({ error: 'Invalid Clerk token' });
        }
        const user = await clerkClient.users.getUser(clerkUserId);
        req.clerkUser = {
            id: clerkUserId,
            email: user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress,
            firstName: user?.firstName || '',
            lastName: user?.lastName || '',
            imageUrl: user?.imageUrl || '',
            fullUser: user,
        };
        next();
    } catch (err) {
        console.error('Clerk auth error:', err);
        return res.status(401).json({ error: 'Unauthorized' });
    }
};

const mapPriceIdToPlan = (priceId) => {
    const entry = Object.entries(PRICE_MAP).find(([, value]) => value === priceId);
    if (!entry) return {};
    const [key] = entry;
    const [planId, billingCycle] = key.split('_');
    return { planId, billingCycle };
};

const upsertSubscription = async ({
    clerkUserId,
    priceId,
    status,
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodEnd,
    cancelAtPeriodEnd,
}) => {
    if (!firestore) return;
    const { planId = null, billingCycle = null } = mapPriceIdToPlan(priceId);
    const planName = planId ? `${planId.charAt(0).toUpperCase()}${planId.slice(1)}` : null;
    const subRef = firestore.collection('users').doc(clerkUserId).collection('meta').doc('subscription');
    await subRef.set(
        {
            planId,
            planName,
            billingCycle,
            status: status || null,
            stripeCustomerId: stripeCustomerId || null,
            stripeSubscriptionId: stripeSubscriptionId || null,
            currentPeriodEnd: currentPeriodEnd ? admin.firestore.Timestamp.fromMillis(currentPeriodEnd) : null,
            cancelAtPeriodEnd: Boolean(cancelAtPeriodEnd),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
};

// Middleware
app.use(cors());
// Use raw body for Stripe webhooks; JSON for everything else
app.use((req, res, next) => {
    if (req.originalUrl === '/stripe/webhook') {
        return next();
    }
    return express.json()(req, res, next);
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'Server is running' });
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.post('/auth/firebase-token', requireClerkAuth, async (req, res) => {
    try {
        if (!admin.apps.length || !firestore) {
            return res.status(500).json({ error: 'Firebase not configured on server' });
        }
        const { id, email, firstName, lastName, imageUrl } = req.clerkUser;
        const firebaseCustomToken = await admin.auth().createCustomToken(id);

        const userRef = firestore.collection('users').doc(id);
        await userRef.set(
            {
                clerkId: id,
                email: email || null,
                firstName: firstName || null,
                lastName: lastName || null,
                photoUrl: imageUrl || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        return res.json({ firebaseCustomToken, userId: id });
    } catch (err) {
        console.error('Firebase token creation error:', err);
        return res.status(500).json({ error: 'Failed to create Firebase token' });
    }
});

app.get('/plans', (_req, res) => {
    const plans = Object.keys(PRICE_MAP || {}).reduce((acc, key) => {
        const [planId, billingCycle] = key.split('_');
        if (!acc[planId]) acc[planId] = { id: planId, prices: {} };
        acc[planId].prices[billingCycle] = PRICE_MAP[key];
        return acc;
    }, {});
    res.json({ plans: Object.values(plans) });
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

const getSubscription = async (clerkUserId) => {
    if (!firestore || !clerkUserId) return null;
    const docRef = firestore.collection('users').doc(clerkUserId).collection('meta').doc('subscription');
    const snap = await docRef.get();
    return snap.exists ? snap.data() : null;
};

app.post('/ai/analyze', requireClerkAuth, async (req, res) => {
    const {
        type = 'url',
        url,
        metadata = {},
        imageBase64,
        currentFolders,
        preferredFolders,
    } = req.body || {};

    try {
        // Enforce active subscription if Firestore is available
        const sub = await getSubscription(req.clerkUser?.id);
        if (sub && sub.status && sub.status !== 'active') {
            return res.status(403).json({ error: 'Subscription inactive' });
        }

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

        let raw;

        if (OPENAI_ASSISTANT_ID) {
            console.log('AI analyze using assistant:', OPENAI_ASSISTANT_ID);

            // Create a thread
            const thread = await openaiClient.beta.threads.create();

            // Add message to thread - Assistants API format
            const messageContent = imageBase64
                ? [
                    { type: 'text', text: userText || 'Analyze this content.' },
                    {
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
                    }
                ]
                : userText || 'Analyze this content.';

            await openaiClient.beta.threads.messages.create(thread.id, {
                role: 'user',
                content: messageContent
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

const findOrCreateStripeCustomer = async ({ email, name, clerkUserId }) => {
    // Try to find by email
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data?.length) {
        const customer = existing.data[0];
        // ensure metadata has clerkUserId
        if (!customer.metadata?.clerkUserId && clerkUserId) {
            await stripe.customers.update(customer.id, { metadata: { clerkUserId } });
        }
        return customer.id;
    }
    const created = await stripe.customers.create({
        email,
        name,
        metadata: { clerkUserId },
    });
    return created.id;
};

app.post('/create-subscription', requireClerkAuth, async (req, res) => {
    try {
        const { planId, billingCycle, metadata = {} } = req.body || {};
        const priceId = PRICE_MAP[`${planId}_${billingCycle}`];
        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan or billing cycle' });
        }

        const email = req.clerkUser?.email;
        const name = `${req.clerkUser?.firstName || ''} ${req.clerkUser?.lastName || ''}`.trim() || undefined;
        const clerkUserId = req.clerkUser?.id;

        const customerId = await findOrCreateStripeCustomer({ email, name, clerkUserId });

        // Create subscription in incomplete state to use PaymentSheet client secret
        const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            metadata: {
                clerkUserId,
                planId,
                billingCycle,
                ...metadata,
            },
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
            customerEphemeralKeySecret: ephemeralKey.secret,
            // alias for backward compatibility
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

const extractClerkIdFromCustomer = async (customerId) => {
    try {
        const customer = await stripe.customers.retrieve(customerId);
        return customer?.metadata?.clerkUserId || null;
    } catch (err) {
        console.error('Failed to retrieve customer', err);
        return null;
    }
};

const handleSubscriptionUpdate = async (subscription, explicitStatus) => {
    const clerkUserId =
        subscription?.metadata?.clerkUserId ||
        subscription?.client_reference_id ||
        (subscription?.customer ? await extractClerkIdFromCustomer(subscription.customer) : null);

    if (!clerkUserId) {
        console.warn('No clerkUserId on subscription update');
        return;
    }

    const priceId = subscription?.items?.data?.[0]?.price?.id;
    await upsertSubscription({
        clerkUserId,
        priceId,
        status: explicitStatus || subscription.status,
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
};

const handleCheckoutCompleted = async (session) => {
    const clerkUserId =
        session.client_reference_id ||
        session?.metadata?.clerkUserId ||
        (session?.customer ? await extractClerkIdFromCustomer(session.customer) : null);

    if (!clerkUserId) {
        console.warn('No clerkUserId on checkout.session.completed');
        return;
    }

    // Retrieve subscription to get price id and period end
    if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await handleSubscriptionUpdate(subscription);
    }
};

// Webhook endpoint for Stripe events
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;
            case 'customer.subscription.created':
                await handleSubscriptionUpdate(event.data.object);
                break;
            case 'customer.subscription.updated':
                await handleSubscriptionUpdate(event.data.object);
                break;
            case 'customer.subscription.deleted':
                await handleSubscriptionUpdate(event.data.object, 'canceled');
                break;
            case 'payment_intent.succeeded': {
                const pi = event.data.object;
                if (pi.metadata?.subscription) {
                    const subscription = await stripe.subscriptions.retrieve(pi.metadata.subscription);
                    await handleSubscriptionUpdate(subscription);
                }
                break;
            }
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                if (invoice.subscription) {
                    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
                    await handleSubscriptionUpdate(subscription, 'past_due');
                }
                break;
            }
            default:
                console.log(`Unhandled event type ${event.type}`);
        }
    } catch (err) {
        console.error('Webhook processing error:', err);
        return res.status(500).send('Webhook handler error');
    }

    res.json({ received: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
