const express = require('express');
const cors = require('cors');
require('dotenv').config();
const OpenAI = require('openai');
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

const requireFirebaseAuth = async (req, res, next) => {
    try {
        const token = extractBearer(req);
        if (!token) {
            return res.status(401).json({ error: 'Missing Authorization bearer token' });
        }
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = {
            uid: decoded.uid,
            email: decoded.email || null,
            name: decoded.name || '',
            picture: decoded.picture || '',
        };
        try {
            await ensurePromoProSubscription(decoded.uid);
        } catch (promoErr) {
            console.error('ensurePromoProSubscription error:', promoErr);
        }
        next();
    } catch (err) {
        console.error('Firebase auth error:', err);
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
    userId,
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
    const subRef = firestore.collection('users').doc(userId).collection('meta').doc('subscription');
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

const ensurePromoProSubscription = async (userId) => {
    if (!firestore || !userId) return;
    const subRef = firestore.collection('users').doc(userId).collection('meta').doc('subscription');
    const snap = await subRef.get();
    const existing = snap.exists ? snap.data() : null;

    // If they already have a Stripe-backed sub, leave it alone
    if (existing?.stripeSubscriptionId || existing?.stripeCustomerId) return;
    // If already marked promo pro and active, leave it
    if (existing?.planId === 'pro' && existing?.status === 'active' && existing?.promoUnlock === true) return;

    await subRef.set(
        {
            planId: 'pro',
            planName: 'Pro',
            billingCycle: existing?.billingCycle || 'monthly',
            status: 'active',
            stripeCustomerId: existing?.stripeCustomerId || null,
            stripeSubscriptionId: existing?.stripeSubscriptionId || null,
            currentPeriodEnd: existing?.currentPeriodEnd || null,
            cancelAtPeriodEnd: false,
            promoUnlock: true,
            promoGrantedAt: admin.firestore.FieldValue.serverTimestamp(),
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

// Client config for version gating
const IOS_MIN_VERSION = process.env.IOS_MIN_VERSION || '1.2.0';
const ANDROID_MIN_VERSION = process.env.ANDROID_MIN_VERSION || '1.2.0';

app.get('/config', (_req, res) => {
    res.json({
        ios: { minVersion: IOS_MIN_VERSION },
        android: { minVersion: ANDROID_MIN_VERSION },
    });
});

const parseBooleanish = (value) => {
    if (value === true || value === false) return value;
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    return null;
};

const extractYouTubeVideoId = (input) => {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

    try {
        const url = new URL(trimmed);
        const v = url.searchParams.get('v');
        if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

        const parts = url.pathname.split('/').filter(Boolean);
        const candidate = parts[0] === 'shorts' || parts[0] === 'embed' ? parts[1] : parts[0];
        if (candidate && /^[a-zA-Z0-9_-]{11}$/.test(candidate)) return candidate;
    } catch {
        // Not a URL
    }

    return null;
};

const chooseBestBy = (items, scoreFn) => {
    if (!Array.isArray(items) || !items.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const item of items) {
        const score = scoreFn(item);
        if (typeof score !== 'number' || Number.isNaN(score)) continue;
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }
    return best;
};

const createHttpError = (status, message, details) => {
    const err = new Error(message);
    err.status = status;
    if (details !== undefined) err.details = details;
    return err;
};

const getHostname = (inputUrl) => {
    try {
        return new URL(inputUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
};

const isHost = (inputUrl, pred) => {
    const host = getHostname(inputUrl);
    if (!host) return false;
    try {
        return Boolean(pred(host));
    } catch {
        return false;
    }
};

const verifyFirebaseAuthForRequest = async (req) => {
    const token = extractBearer(req);
    if (!token) {
        throw createHttpError(401, 'Missing Authorization bearer token');
    }
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = {
            uid: decoded.uid,
            email: decoded.email || null,
            name: decoded.name || '',
            picture: decoded.picture || '',
        };
        try {
            await ensurePromoProSubscription(decoded.uid);
        } catch (promoErr) {
            console.error('ensurePromoProSubscription error:', promoErr);
        }
        return req.user;
    } catch (err) {
        console.error('Firebase auth error:', err);
        throw createHttpError(401, 'Unauthorized');
    }
};

const getYoutubeRapidApiConfig = () => {
    const host = process.env.RAPIDAPI_YOUTUBE_HOST || 'youtube-media-downloader.p.rapidapi.com';
    const key = process.env.RAPIDAPI_KEY || null;
    const path = process.env.RAPIDAPI_YOUTUBE_PATH || '/v2/video/details';
    const requireAuth = (process.env.YOUTUBE_DOWNLOAD_REQUIRE_AUTH || '').toLowerCase() === 'true';
    const timeoutMs = Number(process.env.RAPIDAPI_YOUTUBE_TIMEOUT_MS || 15000);

    return {
        host,
        key,
        path: path.startsWith('/') ? path : `/${path}`,
        requireAuth,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15000,
    };
};

const getTikTokRapidApiConfig = () => {
    const host =
        process.env.RAPIDAPI_TIKTOK_HOST ||
        process.env.RAPIDAPI_HOST ||
        'tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com';
    const key = process.env.RAPIDAPI_KEY || null;
    const path = process.env.RAPIDAPI_TIKTOK_PATH || '/rich_response/index';
    const timeoutMs = Number(process.env.RAPIDAPI_TIKTOK_TIMEOUT_MS || 15000);

    return {
        host,
        key,
        path: path.startsWith('/') ? path : `/${path}`,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15000,
    };
};

const fetchTikTokDownload = async (url) => {
    if (!url) throw createHttpError(400, 'Missing video URL');

    const { host, key, path, timeoutMs } = getTikTokRapidApiConfig();
    if (!host || !key) {
        console.error('RapidAPI host/key not configured.');
        throw createHttpError(500, 'Video download service unavailable');
    }

    const endpoint = `https://${host}${path}?url=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            'x-rapidapi-host': host,
            'x-rapidapi-key': key,
        },
        signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
        const text = await response.text();
        console.error('RapidAPI TikTok error:', response.status, text);
        throw createHttpError(502, 'Failed to download video', { status: response.status });
    }

    const data = await response.json();
    const mp4 = Array.isArray(data?.video) ? data.video[0] : data?.video || null;
    const thumbnail =
        (Array.isArray(data?.cover) ? data.cover[0] : data?.cover) ||
        (Array.isArray(data?.dynamic_cover) ? data.dynamic_cover[0] : data?.dynamic_cover) ||
        null;
    const title = (Array.isArray(data?.description) ? data.description[0] : data?.description) || '';

    if (!mp4) {
        throw createHttpError(502, 'Failed to extract video');
    }

    return { mp4, thumbnail, title };
};

// TikTok video download proxy via RapidAPI
app.post('/video/download', async (req, res) => {
    try {
        const { url } = req.body || {};
        const { mp4, thumbnail, title } = await fetchTikTokDownload(url);
        return res.json({
            mp4,
            thumbnail,
            title,
            source: 'tiktok',
        });
    } catch (err) {
        console.error('TikTok download error:', err);
        return res.status(err?.status || 500).json({ error: err?.message || 'Server error' });
    }
});

const fetchYoutubeDownloadData = async (payload, req) => {
    const { host, key, path, requireAuth, timeoutMs } = getYoutubeRapidApiConfig();

    if (requireAuth) {
        if (!firebaseConfig || !admin.apps.length) {
            throw createHttpError(500, 'Auth required but Firebase not configured');
        }
        await verifyFirebaseAuthForRequest(req);
    }

    const {
        videoId: incomingVideoId,
        url: incomingUrl,
        urlAccess = 'normal',
        lang,
        videos = 'auto',
        audios = 'auto',
        includeRaw,
    } = payload || {};

    const videoId = extractYouTubeVideoId(incomingVideoId || incomingUrl);
    if (!videoId) {
        throw createHttpError(400, 'Missing or invalid videoId (or url)');
    }

    if (!host || !key) {
        console.error('RapidAPI YouTube host/key not configured.');
        throw createHttpError(500, 'YouTube download service unavailable');
    }

    const qs = new URLSearchParams();
    qs.set('videoId', videoId);
    if (urlAccess) qs.set('urlAccess', urlAccess);
    if (lang) qs.set('lang', lang);
    if (videos) qs.set('videos', videos);
    if (audios) qs.set('audios', audios);

    const requestPaths = [
        path,
        '/v2/video/details',
        '/video/details',
        '/v2/video',
        '/video',
    ].filter((p, idx, arr) => typeof p === 'string' && p.startsWith('/') && arr.indexOf(p) === idx);

    const fetchAttempt = async (tryPath) => {
        const endpoint = `https://${host}${tryPath}?${qs.toString()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    'x-rapidapi-host': host,
                    'x-rapidapi-key': key,
                },
                signal: controller.signal,
            });

            const text = await response.text();
            let data;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }

            return { response, text, data, endpoint };
        } finally {
            clearTimeout(timeout);
        }
    };

    let lastAttempt = null;
    for (const tryPath of requestPaths) {
        lastAttempt = await fetchAttempt(tryPath);
        if (lastAttempt.response.ok) break;

        const message = lastAttempt.data?.message || lastAttempt.data?.error || '';
        const isMissingEndpoint =
            lastAttempt.response.status === 404 &&
            typeof message === 'string' &&
            message.toLowerCase().includes('does not exist');

        if (!isMissingEndpoint) break;
    }

    const response = lastAttempt?.response;
    const text = lastAttempt?.text;
    const data = lastAttempt?.data;
    const endpoint = lastAttempt?.endpoint;

    if (!response?.ok) {
        console.error('RapidAPI YouTube error:', response?.status, endpoint, text?.slice?.(0, 500) || text);
        const message = data?.message || data?.error || 'Failed to fetch YouTube download data';
        throw createHttpError(502, message, { status: response?.status || 502 });
    }

    const thumbnails = Array.isArray(data?.thumbnails) ? data.thumbnails : [];
    const bestThumbnail = chooseBestBy(thumbnails, (t) => (t?.width || 0) * (t?.height || 0));

    const videosItems = Array.isArray(data?.videos?.items) ? data.videos.items : [];
    const audiosItems = Array.isArray(data?.audios?.items) ? data.audios.items : [];

    const normalizedVideos = videosItems.map((v) => ({
        url: v?.url || null,
        quality: v?.quality || null,
        width: typeof v?.width === 'number' && Number.isFinite(v.width) ? v.width : null,
        height: typeof v?.height === 'number' && Number.isFinite(v.height) ? v.height : null,
        hasAudio: v?.hasAudio === true,
        extension: v?.extension || null,
        mimeType: v?.mimeType || null,
        size: typeof v?.size === 'number' && Number.isFinite(v.size) ? v.size : null,
        sizeText: v?.sizeText || null,
        lengthMs: typeof v?.lengthMs === 'number' && Number.isFinite(v.lengthMs) ? v.lengthMs : null,
    }));

    const normalizedAudios = audiosItems.map((a) => ({
        url: a?.url || null,
        extension: a?.extension || null,
        mimeType: a?.mimeType || null,
        size: typeof a?.size === 'number' && Number.isFinite(a.size) ? a.size : null,
        sizeText: a?.sizeText || null,
        lengthMs: typeof a?.lengthMs === 'number' && Number.isFinite(a.lengthMs) ? a.lengthMs : null,
        isDrc: a?.isDrc === true,
    }));

    const bestVideoWithAudio = chooseBestBy(
        normalizedVideos.filter((v) => v?.url && v?.hasAudio),
        (v) => (v?.height || 0) * 1_000_000 + (v?.width || 0)
    );

    const bestAudio = chooseBestBy(
        normalizedAudios.filter((a) => a?.url),
        (a) => a?.size || 0
    );

    const includeRawBool = parseBooleanish(includeRaw);

    return {
        source: 'youtube',
        id: data?.id || videoId,
        title: data?.title || '',
        description: data?.description || '',
        channel: data?.channel
            ? {
                id: data.channel?.id || null,
                name: data.channel?.name || '',
                handle: data.channel?.handle || '',
                avatar: Array.isArray(data.channel?.avatar) ? data.channel.avatar : [],
            }
            : null,
        lengthSeconds: data?.lengthSeconds ? Number(data.lengthSeconds) : null,
        thumbnails,
        thumbnail: bestThumbnail?.url || null,
        recommended: {
            videoWithAudio: bestVideoWithAudio,
            audio: bestAudio,
        },
        videos: normalizedVideos,
        audios: normalizedAudios,
        raw: includeRawBool ? data : undefined,
    };
};

const youtubeDownloadHandler = async (req, res) => {
    try {
        const payload = {
            ...(req.query || {}),
            ...(req.body || {}),
        };
        const data = await fetchYoutubeDownloadData(payload, req);
        return res.json(data);
    } catch (err) {
        const aborted = err?.name === 'AbortError';
        console.error('YouTube download error:', err);
        return res
            .status(aborted ? 504 : err?.status || 500)
            .json({ error: aborted ? 'YouTube download timed out' : err?.message || 'Server error' });
    }
};

// YouTube download data proxy via RapidAPI (youtube-media-downloader)
app.get('/youtube/download', youtubeDownloadHandler);
app.post('/youtube/download', youtubeDownloadHandler);

// Generic resolver for multiple providers
app.post('/download/resolve', async (req, res) => {
    try {
        const requireAuth = (process.env.DOWNLOAD_RESOLVE_REQUIRE_AUTH || '').toLowerCase() === 'true';
        if (requireAuth) {
            if (!firebaseConfig || !admin.apps.length) {
                return res.status(500).json({ error: 'Auth required but Firebase not configured' });
            }
            let nextCalled = false;
            await requireFirebaseAuth(req, res, () => {
                nextCalled = true;
            });
            if (!nextCalled) return;
        }

        const { url } = req.body || {};
        if (!url) return res.status(400).json({ error: 'Missing url' });

        // Allowlist supported hosts to avoid using this as a generic proxy.
        const isYouTube = isHost(url, (h) => h === 'youtu.be' || h.endsWith('youtube.com'));
        const isTikTok = isHost(url, (h) => h.endsWith('tiktok.com') || h.endsWith('tiktokcdn.com') || h.endsWith('tiktokv.com'));

        if (isYouTube) {
            const data = await fetchYoutubeDownloadData({ url }, req);
            const assetUrl =
                data?.recommended?.videoWithAudio?.url ||
                data?.videos?.find((v) => v?.url)?.url ||
                null;
            if (!assetUrl) return res.status(502).json({ error: 'No downloadable video URL' });
            return res.json({
                provider: 'youtube',
                mediaType: 'video',
                assetUrl,
                thumbnail: data?.thumbnail || null,
                title: data?.title || '',
            });
        }

        if (isTikTok) {
            const data = await fetchTikTokDownload(url);
            return res.json({
                provider: 'tiktok',
                mediaType: 'video',
                assetUrl: data.mp4,
                thumbnail: data.thumbnail || null,
                title: data.title || '',
            });
        }

        return res.status(400).json({ error: 'Unsupported URL' });
    } catch (err) {
        console.error('download/resolve error', err);
        return res.status(err?.status || 500).json({ error: err?.message || 'Server error' });
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

const findOrCreateStripeCustomer = async ({ email, name, firebaseUid }) => {
    // Try to find by email
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data?.length) {
        const customer = existing.data[0];
        // ensure metadata has firebaseUid
        if (!customer.metadata?.firebaseUid && firebaseUid) {
            await stripe.customers.update(customer.id, { metadata: { firebaseUid } });
        }
        return customer.id;
    }
    const created = await stripe.customers.create({
        email,
        name,
        metadata: { firebaseUid },
    });
    return created.id;
};

app.post('/create-subscription', requireFirebaseAuth, async (req, res) => {
    try {
        const { planId, billingCycle, metadata = {} } = req.body || {};
        const priceId = PRICE_MAP[`${planId}_${billingCycle}`];
        if (!priceId) {
            return res.status(400).json({ error: 'Invalid plan or billing cycle' });
        }

        const email = req.user?.email;
        const name = req.user?.name || undefined;
        const firebaseUid = req.user?.uid;

        const customerId = await findOrCreateStripeCustomer({ email, name, firebaseUid });

        // Create subscription in incomplete state to use PaymentSheet client secret
        const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            metadata: {
                firebaseUid,
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

const extractFirebaseUidFromCustomer = async (customerId) => {
    try {
        const customer = await stripe.customers.retrieve(customerId);
        return customer?.metadata?.firebaseUid || null;
    } catch (err) {
        console.error('Failed to retrieve customer', err);
        return null;
    }
};

const handleSubscriptionUpdate = async (subscription, explicitStatus) => {
    const firebaseUid =
        subscription?.metadata?.firebaseUid ||
        subscription?.client_reference_id ||
        (subscription?.customer ? await extractFirebaseUidFromCustomer(subscription.customer) : null);

    if (!firebaseUid) {
        console.warn('No firebaseUid on subscription update');
        return;
    }

    const priceId = subscription?.items?.data?.[0]?.price?.id;
    await upsertSubscription({
        userId: firebaseUid,
        priceId,
        status: explicitStatus || subscription.status,
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
};

const handleCheckoutCompleted = async (session) => {
    const firebaseUid =
        session.client_reference_id ||
        session?.metadata?.firebaseUid ||
        (session?.customer ? await extractFirebaseUidFromCustomer(session.customer) : null);

    if (!firebaseUid) {
        console.warn('No firebaseUid on checkout.session.completed');
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
