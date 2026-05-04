const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { apiLimiter, authLimiter, paymentLimiter } = require('./rate-limit');
const { validators, sanitize } = require('./validators.cjs');

// ─── Segredos ─────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.VITE_STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_DEACTIVATE_CODE = process.env.ADMIN_DEACTIVATE_CODE;
const JWT_SECRET = process.env.JWT_SECRET;

// ─── Validação de variáveis obrigatórias ──────────────────────────────────────
const missingVars = [];
if (!ADMIN_PASSWORD) missingVars.push('ADMIN_PASSWORD');
if (!ADMIN_USERNAME) missingVars.push('ADMIN_USERNAME');
if (!ADMIN_DEACTIVATE_CODE) missingVars.push('ADMIN_DEACTIVATE_CODE');
if (!JWT_SECRET) missingVars.push('JWT_SECRET');

if (missingVars.length > 0) {
    console.error(`\n⛔ ERRO CRÍTICO: Variáveis de ambiente obrigatórias não configuradas:\n   ${missingVars.join(', ')}\n`);
    process.exit(1);
}

if (!STRIPE_SECRET_KEY) {
    console.warn('⚠ AVISO: STRIPE_SECRET_KEY não configurada. Pagamentos Stripe desabilitados.');
}
if (!process.env.STRIPE_PRICE_ID_PROPRIETARIO) {
    console.warn('⚠ AVISO: STRIPE_PRICE_ID_PROPRIETARIO não configurada.');
}

const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
const app = express();

// ─── Firebase Admin SDK ───────────────────────────────────────────────────────
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✓ Firebase Admin SDK inicializado com sucesso.');
} catch (error) {
    console.warn('\n⚠ Firebase Admin SDK não inicializado:', error.message, '\n');
}

// ─── Admin Auth Middleware (JWT) ───────────────────────────────────────────────
function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(403).json({ error: 'Acesso não autorizado.' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.role !== 'admin') throw new Error('Role inválida');
        req.adminPayload = payload;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token inválido ou expirado.' });
    }
}

// ─── Firebase ID Token Middleware ─────────────────────────────────────────────
async function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Token de autenticação ausente.' });
    if (admin.apps.length === 0) return res.status(503).json({ error: 'Firebase Admin não disponível.' });
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.firebaseUser = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token de autenticação inválido.' });
    }
}

// ─── Admin HTML Routes ────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/admin/index.html', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

const ADMIN_PAGES = ['dashboard.html', 'cadastro-vets.html', 'perfil-vets.html', 'ajuda-vets.html'];
app.get('/admin/:page', (req, res, next) => {
    const page = req.params.page;
    if (!ADMIN_PAGES.includes(page)) return next();
    res.sendFile(path.join(__dirname, 'admin', page));
});

// ─── Portal do Proprietário HTML Routes ──────────────────────────────────────
const PROPRIETARIO_PAGES = [
    'index-proprietario.html', 'cadastro-proprietarios.html',
    'dashboard-proprietarios.html', 'cavalos-proprietarios.html',
    'dossie-proprietarios.html', 'faturas-proprietarios.html',
    'detalhe-faturaproprietarios.html', 'financeiro-proprietarios.html',
    'receitas-proprietarios.html', 'termos-lgpd.html'
];
app.get('/proprietarios', (req, res) => res.sendFile(path.join(__dirname, 'proprietarios', 'index-proprietario.html')));
app.get('/proprietarios/', (req, res) => res.sendFile(path.join(__dirname, 'proprietarios', 'index-proprietario.html')));
app.get('/proprietarios/:page', (req, res, next) => {
    const page = req.params.page;
    if (!PROPRIETARIO_PAGES.includes(page)) return next();
    res.sendFile(path.join(__dirname, 'proprietarios', page));
});

// ─── Rota explícita para novo-atendimento ────────────────────────────────────
const ATENDIMENTO_PAGE = 'novo-atendimento_1775208974082.html';
app.get('/novo-atendimento', (req, res) => res.sendFile(path.join(__dirname, ATENDIMENTO_PAGE)));
app.get(`/${ATENDIMENTO_PAGE}`, (req, res) => res.sendFile(path.join(__dirname, ATENDIMENTO_PAGE)));

// ─── Admin API: Login ─────────────────────────────────────────────────────────
app.post('/api/admin/login', authLimiter, express.json({ limit: '10kb' }), (req, res) => {
    const { password, username } = req.body || {};
    const crypto = require('crypto');
    let pwdMatch = false, userMatch = false;
    try {
        pwdMatch = crypto.timingSafeEqual(Buffer.from(password || ''), Buffer.from(ADMIN_PASSWORD || ''));
        userMatch = crypto.timingSafeEqual(Buffer.from(username || ''), Buffer.from(ADMIN_USERNAME || ''));
    } catch (_) {}
    if (!password || !username || !pwdMatch || !userMatch) {
        return res.status(401).json({ error: 'Credenciais incorretas.' });
    }
    const token = jwt.sign(
        { role: 'admin', iat: Math.floor(Date.now() / 1000) },
        JWT_SECRET,
        { expiresIn: '2h' }
    );
    res.json({ token, success: true });
});

// ─── Admin API: Verificar Token ───────────────────────────────────────────────
app.get('/api/admin/verify-token', adminAuth, (req, res) => {
    res.json({ valid: true });
});

// ─── Admin API: Lista de Vets ─────────────────────────────────────────────────
app.get('/api/admin/vets', apiLimiter, adminAuth, async (req, res) => {
    try {
        const db = admin.firestore();
        const vetsSnap = await db.collection('veterinarios').get();
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const vetPromises = vetsSnap.docs.map(async (docSnap) => {
            const d = docSnap.data();
            const [atendSnap, comissao] = await Promise.all([
                db.collection('atendimentos').where('userId', '==', docSnap.id).where('status', '==', 'pago').get(),
                (async () => {
                    if (!stripe || !d.stripeSubscriptionId) return 0;
                    try {
                        const invoices = await stripe.invoices.list({ subscription: d.stripeSubscriptionId, status: 'paid', limit: 100 });
                        return invoices.data.reduce((s, inv) => s + (inv.amount_paid / 100), 0);
                    } catch (_) { return 0; }
                })()
            ]);
            const faturamentoTotal = atendSnap.docs.reduce((s, a) => s + (a.data().total_geral || 0), 0);
            const createdAt = d.createdAt;
            const createdDate = createdAt?._seconds ? new Date(createdAt._seconds * 1000) : null;
            return {
                uid: docSnap.id,
                nome: d.nome || d.razao_social || 'Sem nome',
                email: d.email || '',
                telefone: d.telefone || '',
                crmv: d.crmv || '',
                crmv_uf: d.crmv_uf || '',
                tipo: d.tipo || 'pf',
                createdAt: createdAt || null,
                stripeStatus: d.stripeStatus || d.subscriptionStatus || '',
                stripeSubscriptionId: d.stripeSubscriptionId || '',
                ativo: ['active', 'trial'].includes(d.stripeStatus) || d.subscriptionStatus === 'active',
                faturamentoTotal,
                comissao,
                atendimentosTotal: atendSnap.size,
                isNew24h: createdDate && createdDate >= oneDayAgo
            };
        });
        const vets = await Promise.all(vetPromises);
        vets.sort((a, b) => b.comissao - a.comissao);
        res.json({ vets, activeCount: vets.filter(v => v.ativo).length, newIn24h: vets.filter(v => v.isNew24h).length });
    } catch (err) {
        console.error('Admin vets error:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Admin API: Perfil de Vet ─────────────────────────────────────────────────
app.get('/api/admin/vet/:uid', apiLimiter, adminAuth, async (req, res) => {
    // Validar formato do uid (consistência com deactivate)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.uid)) {
        return res.status(400).json({ error: 'UID inválido.' });
    }
    try {
        const db = admin.firestore();
        const vetDoc = await db.collection('veterinarios').doc(req.params.uid).get();
        if (!vetDoc.exists) return res.status(404).json({ error: 'Veterinário não encontrado.' });
        const d = vetDoc.data();
        const atendSnap = await db.collection('atendimentos').where('userId', '==', req.params.uid).get();
        const atendimentos = atendSnap.docs.map(a => a.data());
        const faturamentoTotal = atendimentos.filter(a => a.status === 'pago').reduce((s, a) => s + (a.total_geral || 0), 0);
        let comissao = 0, stripeData = null;
        if (stripe && d.stripeSubscriptionId) {
            try {
                const [sub, invoices] = await Promise.all([
                    stripe.subscriptions.retrieve(d.stripeSubscriptionId),
                    stripe.invoices.list({ subscription: d.stripeSubscriptionId, status: 'paid', limit: 100 })
                ]);
                comissao = invoices.data.reduce((s, inv) => s + (inv.amount_paid / 100), 0);
                stripeData = { status: sub.status, currentPeriodEnd: sub.current_period_end };
            } catch (_) {}
        }
        res.json({ uid: vetDoc.id, ...d, faturamentoTotal, comissao, atendimentosCount: atendimentos.length, atendimentosPagos: atendimentos.filter(a => a.status === 'pago').length, stripeData });
    } catch (err) {
        console.error('Admin vet detail error:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Admin API: Desativar Vet ─────────────────────────────────────────────────
app.post('/api/admin/vet/deactivate', apiLimiter, adminAuth, express.json({ limit: '10kb' }), async (req, res) => {
    const { uid, confirmCode } = req.body || {};
    if (!confirmCode || confirmCode !== ADMIN_DEACTIVATE_CODE) {
        return res.status(403).json({ error: 'Código de confirmação incorreto.' });
    }
    if (!uid || typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid.trim())) {
        return res.status(400).json({ error: 'UID inválido.' });
    }
    const uidClean = uid.trim();
    try {
        const db = admin.firestore();
        await admin.auth().updateUser(uidClean, { disabled: true });
        await db.collection('veterinarios').doc(uidClean).update({
            ativo: false, stripeStatus: 'deactivated',
            desativadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        const vetDoc = await db.collection('veterinarios').doc(uidClean).get();
        const subId = vetDoc.data()?.stripeSubscriptionId;
        if (stripe && subId) { try { await stripe.subscriptions.cancel(subId); } catch (_) {} }
        try {
            await db.collection('audit_log').add({
                acao: 'vet_desativado', uidAlvo: uidClean,
                adminRole: req.adminPayload?.role || 'admin',
                ip: req.ip || 'desconhecido',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (logErr) { console.error('Erro ao registrar audit_log:', logErr); }
        res.json({ success: true });
    } catch (err) {
        console.error('Admin deactivate error:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Admin API: Central de Ajuda ─────────────────────────────────────────────
app.get('/api/admin/ajuda', apiLimiter, adminAuth, async (req, res) => {
    try {
        const db = admin.firestore();
        const snap = await db.collection('pedidos_ajuda').orderBy('criadoEm', 'desc').get();
        res.json({ requests: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    } catch (err) {
        console.error('Admin ajuda list error:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.patch('/api/admin/ajuda/:id', apiLimiter, adminAuth, express.json({ limit: '10kb' }), async (req, res) => {
    const STATUS_ALLOWED = ['pendente', 'em_atendimento', 'resolvido'];
    const { status } = req.body || {};
    if (!status || !STATUS_ALLOWED.includes(status)) {
        return res.status(400).json({ error: 'Status inválido.' });
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.id)) {
        return res.status(400).json({ error: 'ID inválido.' });
    }
    try {
        const db = admin.firestore();
        await db.collection('pedidos_ajuda').doc(req.params.id).update({
            status, atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (err) {
        console.error('Admin ajuda patch error:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Admin API: Dados Financeiros ─────────────────────────────────────────────
app.get('/api/admin/financeiro', apiLimiter, adminAuth, async (req, res) => {
    try {
        const db = admin.firestore();
        const now = new Date();
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const [atendSnap, vetsSnap] = await Promise.all([
            db.collection('atendimentos').where('data', '>=', admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
            db.collection('veterinarios').get()
        ]);
        const byDay = {};
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now); d.setDate(d.getDate() - i);
            byDay[d.toISOString().split('T')[0]] = { count: 0, revenue: 0 };
        }
        atendSnap.docs.forEach(docSnap => {
            const a = docSnap.data();
            if (!a.data) return;
            const ts = a.data._seconds ? new Date(a.data._seconds * 1000) : (a.data.toDate ? a.data.toDate() : new Date(a.data));
            const key = ts.toISOString().split('T')[0];
            if (byDay[key]) { byDay[key].count++; if (a.status === 'pago') byDay[key].revenue += (a.total_geral || 0); }
        });
        const days = Object.keys(byDay).sort();
        const activeVets = vetsSnap.docs.filter(d => ['active', 'trial'].includes(d.data().stripeStatus) || d.data().subscriptionStatus === 'active').length;
        res.json({
            days, dailyCounts: days.map(d => byDay[d].count), dailyRevenue: days.map(d => byDay[d].revenue),
            activeVets, totalAtendimentos: atendSnap.size,
            totalRevenue: atendSnap.docs.filter(d => d.data().status === 'pago').reduce((s, d) => s + (d.data().total_geral || 0), 0)
        });
    } catch (err) {
        console.error('Admin financeiro error:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Bloqueio de arquivos sensíveis ──────────────────────────────────────────
app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    // Admin protegido - apenas rotas explícitas acima são permitidas
    if (p.startsWith('/admin/') || p === '/admin') return res.status(403).json({ error: 'Acesso negado.' });
    // Git
    if (p.startsWith('/.git')) return res.status(403).json({ error: 'Acesso negado.' });
    // Arquivos .txt na raiz
    if (/^\/[^/]*\.txt$/i.test(req.path)) return res.status(403).json({ error: 'Acesso negado.' });
    // Arquivos .md e .nix (replit.md, replit.nix)
    if (/^\/[^/]*\.(md|nix)$/i.test(req.path)) return res.status(403).json({ error: 'Acesso negado.' });
    // /functions
    if (p.startsWith('/functions')) return res.status(403).json({ error: 'Acesso negado.' });
    // /ARQUIVOS-DEV/ e /attached_assets/
    if (p.startsWith('/arquivos-dev') || p.startsWith('/attached_assets')) return res.status(403).json({ error: 'Acesso negado.' });
    // /.well-known/
    if (p.startsWith('/.well-known')) return res.status(403).json({ error: 'Acesso negado.' });
    // /scripts/
    if (p.startsWith('/scripts')) return res.status(403).json({ error: 'Acesso negado.' });
    // Arquivos sensíveis explícitos
    const blocked = [
        '/.env', '/.env.local', '/.env.production',
        '/serviceaccountkey.json',
        '/package.json', '/package-lock.json',
        '/firebase.json', '/firestore.rules', '/firestore.indexes.json',
        '/rate-limit.js', '/server.js', '/validators.js', '/validators.cjs',
        '/functions/index.js', '/proprietarios.txt'
    ];
    if (blocked.includes(p)) return res.status(403).json({ error: 'Acesso negado.' });
    next();
});

// ─── Headers de Segurança ─────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com www.gstatic.com js.stripe.com",
        "style-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com fonts.googleapis.com",
        "font-src 'self' fonts.gstatic.com cdnjs.cloudflare.com",
        "img-src 'self' data: https:",
        "connect-src 'self' firestore.googleapis.com identitytoolkit.googleapis.com securetoken.googleapis.com www.googleapis.com api.stripe.com",
        "frame-src js.stripe.com",
        "object-src 'none'",
        "base-uri 'self'"
    ].join('; '));
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
    'https://vetsmart-11674145-f2ba3.web.app',
    'https://vetsmart-11674145-f2ba3.firebaseapp.com',
];
const allowedOriginPatterns = [/\.replit\.dev$/, /\.replit\.app$/];
if (process.env.NODE_ENV !== 'production') {
    allowedOriginPatterns.push(/localhost/, /127\.0\.0\.1/);
}
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const trusted = allowedOrigins.includes(origin) || allowedOriginPatterns.some(p => p.test(origin));
        callback(null, trusted ? true : false);
    },
    credentials: true
}));

// ─── Stripe Webhook (raw body) ────────────────────────────────────────────────
app.post('/stripe-webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET) return res.status(400).send('Webhook Error: secret não configurado.');
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const eventRef = db.collection('stripe_events_processados').doc(event.id);
            const eventSnap = await eventRef.get();
            if (eventSnap.exists) return res.json({ received: true, duplicate: true });
            await eventRef.set({ eventId: event.id, type: event.type, processadoEm: admin.firestore.FieldValue.serverTimestamp() });
        } catch (idempErr) { console.error('Erro idempotência webhook:', idempErr); }
    }
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = session.metadata || {};
        if (meta.transacaoId && admin.apps.length > 0) {
            try {
                await admin.firestore().collection('atendimentos').doc(meta.transacaoId).update({
                    status: 'pago', pagamentoConfirmadoEm: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (error) { console.error(`Erro ao atualizar atendimento ${meta.transacaoId}:`, error); }
        }
        if (meta.tipo === 'proprietario' && meta.uid && admin.apps.length > 0) {
            try {
                await admin.firestore().collection('proprietarios').doc(meta.uid).update({
                    stripeSubscriptionId: session.subscription || null,
                    stripeStatus: 'trial', plano: 'trial', ativo: true,
                    assinaturaConfirmadaEm: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (error) { console.error(`Erro ao atualizar proprietário ${meta.uid}:`, error); }
        }
    }
    if (event.type === 'customer.subscription.updated' && admin.apps.length > 0) {
        const sub = event.data.object;
        try {
            const db = admin.firestore();
            const propSnap = await db.collection('proprietarios').where('stripeSubscriptionId', '==', sub.id).limit(1).get();
            if (!propSnap.empty) {
                await propSnap.docs[0].ref.update({
                    stripeStatus: sub.status,
                    plano: sub.status === 'active' ? 'ativo' : (sub.status === 'trialing' ? 'trial' : sub.status),
                    ativo: ['active', 'trialing'].includes(sub.status)
                });
            }
            const vetSnap = await db.collection('veterinarios').where('stripeSubscriptionId', '==', sub.id).limit(1).get();
            if (!vetSnap.empty) {
                await vetSnap.docs[0].ref.update({ stripeStatus: sub.status, ativo: ['active', 'trialing'].includes(sub.status) });
            }
        } catch (err) { console.error('Erro ao atualizar assinatura:', err); }
    }
    if (event.type === 'customer.subscription.deleted' && admin.apps.length > 0) {
        const sub = event.data.object;
        try {
            const db = admin.firestore();
            const snap = await db.collection('proprietarios').where('stripeSubscriptionId', '==', sub.id).limit(1).get();
            if (!snap.empty) {
                await snap.docs[0].ref.update({ stripeStatus: 'canceled', plano: 'inativo', ativo: false, canceladoEm: admin.firestore.FieldValue.serverTimestamp() });
            }
        } catch (err) { console.error('Erro ao cancelar assinatura proprietário:', err); }
    }
    res.json({ received: true });
});

// ─── JSON parser + arquivos estáticos ────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname));

// ─── Registrar Proprietário ───────────────────────────────────────────────────
app.post('/api/proprietario/register', paymentLimiter, verifyFirebaseToken, async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase não inicializado.' });
    const { uid, email, nomeCompleto, cpf, cpfFormatado, telefone } = req.body || {};
    if (!uid || !email || !cpf) return res.status(400).json({ error: 'Parâmetros obrigatórios ausentes.' });
    if (uid !== req.firebaseUser.uid) return res.status(403).json({ error: 'Acesso não autorizado.' });
    const cpfDigits = String(cpf).replace(/\D/g, '');
    if (!/^\d{11}$/.test(cpfDigits) || !validators.cpf(cpfDigits)) return res.status(400).json({ error: 'CPF inválido.' });
    if (!validators.email(email)) return res.status(400).json({ error: 'E-mail inválido.' });
    const nomeClean = nomeCompleto ? String(nomeCompleto).trim() : '';
    if (nomeClean.length < 3 || nomeClean.length > 100) return res.status(400).json({ error: 'Nome deve ter entre 3 e 100 caracteres.' });
    if (telefone && !validators.telefone(telefone)) return res.status(400).json({ error: 'Telefone inválido.' });
    try {
        const db = admin.firestore();
        const existingDoc = await db.collection('proprietarios').doc(uid).get();
        if (existingDoc.exists) return res.status(409).json({ error: 'Proprietário já cadastrado.' });
        const cpfQuery = await db.collection('proprietarios').where('cpf', '==', cpfDigits).limit(1).get();
        if (!cpfQuery.empty) return res.status(409).json({ error: 'CPF já cadastrado no sistema.' });
        const agora = admin.firestore.Timestamp.now();
        await db.collection('proprietarios').doc(uid).set({
            uid, nomeCompleto: nomeClean, cpf: cpfDigits,
            cpfFormatado: cpfFormatado || cpfDigits,
            telefone: telefone ? String(telefone).replace(/\D/g, '') : '',
            email: String(email).trim().toLowerCase(),
            plano: 'trial', trialInicio: agora,
            trialFim: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
            criadoEm: agora, ativo: true, stripeCustomerId: null, stripeSubscriptionId: null, ultimosDigitosCartao: null
        }, { merge: false });
        res.json({ ok: true });
    } catch (err) {
        console.error('Erro ao registrar proprietário:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Criar Checkout de Assinatura ─────────────────────────────────────────────
app.post('/create-checkout-subscription', paymentLimiter, verifyFirebaseToken, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Serviço de pagamento não configurado.' });
    const priceId = process.env.STRIPE_PRICE_ID_PROPRIETARIO;
    if (!priceId) return res.status(503).json({ error: 'Plano não configurado.' });
    const { email, nomeCompleto, cpf, uid } = req.body || {};
    if (!email || !uid) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    if (uid !== req.firebaseUser.uid) return res.status(403).json({ error: 'Acesso não autorizado.' });
    try {
        const db = admin.firestore();
        const propDoc = await db.collection('proprietarios').doc(uid).get();
        if (!propDoc.exists) return res.status(400).json({ error: 'Proprietário não encontrado.' });
        const propData = propDoc.data();
        if (propData.stripeSubscriptionId) {
            try {
                const sub = await stripe.subscriptions.retrieve(propData.stripeSubscriptionId);
                if (['active', 'trialing'].includes(sub.status)) return res.status(409).json({ error: 'Já existe uma assinatura ativa.' });
            } catch (_) {}
        }
        const cpfClean = cpf ? sanitize.cpfDigits(cpf) : '';
        const customer = await stripe.customers.create({ email, name: nomeCompleto || '', metadata: { uid, cpf: cpfClean } });
        const CHECKOUT_SITE_URL = process.env.SITE_URL || 'https://vetsmart-11674145-f2ba3.web.app';
        const session = await stripe.checkout.sessions.create({
            customer: customer.id, payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription', subscription_data: { trial_period_days: 30 },
            success_url: `${CHECKOUT_SITE_URL}/proprietarios/dashboard-proprietarios.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${CHECKOUT_SITE_URL}/proprietarios/cadastro-proprietarios.html?cancelled=true`,
            metadata: { uid, cpf: cpfClean, tipo: 'proprietario' }
        });
        if (admin.apps.length > 0) {
            await db.collection('proprietarios').doc(uid).update({ stripeCustomerId: customer.id, stripeSessionId: session.id, stripeStatus: 'checkout_pending' });
        }
        res.json({ url: session.url });
    } catch (err) {
        console.error('Erro ao criar checkout:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Criar Link de Pagamento ──────────────────────────────────────────────────
app.post('/create-payment-link', paymentLimiter, verifyFirebaseToken, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Serviço de pagamento não configurado.' });
    const { amount, productName, transacaoId, userId } = req.body;
    if (!userId || userId !== req.firebaseUser.uid) return res.status(403).json({ error: 'Acesso não autorizado.' });
    if (!amount || !productName || !transacaoId) return res.status(400).json({ error: 'Parâmetros inválidos.' });
    if (!validators.valorMonetario(amount)) return res.status(400).json({ error: 'Valor inválido.' });
    if (!validators.idFirestore(transacaoId)) return res.status(400).json({ error: 'ID de transação inválido.' });
    const productNameClean = sanitize.productName(productName);
    if (!productNameClean) return res.status(400).json({ error: 'Nome do produto inválido.' });
    try {
        const db = admin.firestore();
        const atendRef = db.collection('atendimentos').doc(transacaoId);
        const atendDoc = await atendRef.get();
        if (!atendDoc.exists || atendDoc.data().userId !== req.firebaseUser.uid) return res.status(403).json({ error: 'Acesso não autorizado ao atendimento.' });
        const existingLink = atendDoc.data().stripePaymentLink;
        if (existingLink) return res.json({ url: existingLink });
        const product = await stripe.products.create({ name: productNameClean });
        const price = await stripe.prices.create({ product: product.id, unit_amount: parseInt(amount, 10), currency: 'brl' });
        const SITE_URL = process.env.SITE_URL || 'https://vetsmart-11674145-f2ba3.web.app';
        const paymentLink = await stripe.paymentLinks.create({
            line_items: [{ price: price.id, quantity: 1 }],
            metadata: { transacaoId, userId },
            after_completion: { type: 'redirect', redirect: { url: `${SITE_URL}/pagamento.html?id=${transacaoId}&payment=success` } }
        });
        await atendRef.update({ stripePaymentLink: paymentLink.url });
        res.json({ url: paymentLink.url });
    } catch (error) {
        console.error('Erro ao criar link de pagamento:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Cancelar Assinatura do Proprietário ─────────────────────────────────────
app.post('/api/proprietario/cancelar-assinatura', paymentLimiter, verifyFirebaseToken, async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase não inicializado.' });
    if (!stripe) return res.status(503).json({ error: 'Serviço de pagamento não configurado.' });
    const uid = req.firebaseUser.uid;
    try {
        const db = admin.firestore();
        const propDoc = await db.collection('proprietarios').doc(uid).get();
        if (!propDoc.exists) return res.status(404).json({ error: 'Proprietário não encontrado.' });
        const subId = propDoc.data().stripeSubscriptionId;
        if (subId) { try { await stripe.subscriptions.cancel(subId); } catch (e) { console.error('Erro Stripe cancel:', e.message); } }
        await db.collection('proprietarios').doc(uid).update({ stripeStatus: 'canceled', plano: 'inativo', ativo: false, canceladoEm: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
    } catch (err) {
        console.error('Erro ao cancelar assinatura:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Excluir Dados do Usuário (LGPD) ─────────────────────────────────────────
app.post('/api/conta/excluir-dados', paymentLimiter, verifyFirebaseToken, async (req, res) => {
    if (!admin.apps.length) return res.status(503).json({ error: 'Firebase não inicializado.' });
    const uid = req.firebaseUser.uid;
    const db = admin.firestore();
    try {
        const [propDoc, vetDoc] = await Promise.all([
            db.collection('proprietarios').doc(uid).get(),
            db.collection('veterinarios').doc(uid).get()
        ]);
        const anonTimestamp = admin.firestore.FieldValue.serverTimestamp();
        if (propDoc.exists) {
            const propData = propDoc.data();
            if (stripe && propData.stripeSubscriptionId) { try { await stripe.subscriptions.cancel(propData.stripeSubscriptionId); } catch (_) {} }
            await db.collection('proprietarios').doc(uid).update({ nomeCompleto: '[DADOS EXCLUÍDOS]', cpf: '[EXCLUÍDO]', cpfFormatado: '[EXCLUÍDO]', telefone: '', email: `excluido_${uid}@lgpd.local`, stripeStatus: 'canceled', plano: 'inativo', ativo: false, dadosExcluidosEm: anonTimestamp, _lgpdExcluido: true });
        }
        if (vetDoc.exists) {
            const vetData = vetDoc.data();
            if (stripe && vetData.stripeSubscriptionId) { try { await stripe.subscriptions.cancel(vetData.stripeSubscriptionId); } catch (_) {} }
            await db.collection('veterinarios').doc(uid).update({ nome: '[DADOS EXCLUÍDOS]', email: `excluido_${uid}@lgpd.local`, telefone: '', cpf: '[EXCLUÍDO]', cnpj: '[EXCLUÍDO]', stripeStatus: 'canceled', ativo: false, dadosExcluidosEm: anonTimestamp, _lgpdExcluido: true });
        }
        // Anonimizar atendimentos com paginação completa
        try {
            let lastDoc = null, hasMore = true;
            while (hasMore) {
                let q = db.collection('atendimentos').where('userId', '==', uid).orderBy('__name__').limit(500);
                if (lastDoc) q = q.startAfter(lastDoc);
                const snap = await q.get();
                if (snap.empty) break;
                const batch = db.batch();
                snap.docs.forEach(d => batch.update(d.ref, { nome_cavalo: '[DADOS EXCLUÍDOS]', nome_proprietario: '[DADOS EXCLUÍDOS]', _lgpdExcluido: true }));
                await batch.commit();
                hasMore = snap.size === 500;
                if (hasMore) lastDoc = snap.docs[snap.docs.length - 1];
            }
        } catch (_) {}
        try { await admin.auth().updateUser(uid, { disabled: true }); } catch (_) {}
        try {
            await db.collection('audit_log').add({ acao: 'excluir_dados_lgpd', uid, ip: req.ip || 'desconhecido', timestamp: anonTimestamp });
        } catch (_) {}
        res.json({ ok: true, message: 'Dados pessoais excluídos conforme LGPD.' });
    } catch (err) {
        console.error('Erro ao excluir dados do usuário:', err);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ─── Servidor ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🐴 HorseSmart rodando na porta ${PORT}`);
    console.log(`   App:   http://localhost:${PORT}/login.html`);
    console.log(`   Admin: http://localhost:${PORT}/admin/`);
    console.log(STRIPE_SECRET_KEY ? '✓ Stripe: ativo' : '⚠ Stripe: desabilitado');
    console.log(`✓ Admin: protegido por JWT (expiração 2h)\n`);
});
