const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
db.settings({ databaseId: "horsesmart" });
setGlobalOptions({ region: "southamerica-east1" });

// ─── Whitelist de campos permitidos para veterinários ─────────────────────────
const VET_ALLOWED_FIELDS = [
    'nome', 'razao_social', 'email', 'telefone', 'crmv', 'crmv_uf',
    'tipo', 'cpf', 'cnpj', 'endereco', 'cidade', 'estado', 'cep',
    'especialidade', 'bio', 'foto_url'
];

// ─── 1. updateStockOnPaymentConfirmed ─────────────────────────────────────────
exports.updateStockOnPaymentConfirmed = onDocumentUpdated("atendimentos/{transactionId}", async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    const transactionId = event.params.transactionId;

    if (before.status === "pago" || after.status !== "pago") return;
    if (after.estoqueJaDecrementado === true) return;
    if (!after.insumos || after.insumos.length === 0) return;

    const batch = db.batch();
    const transacaoRef = db.collection("atendimentos").doc(transactionId);

    try {
        for (const insumo of after.insumos) {
            const idDoInsumo = insumo.estoqueId || insumo.id;
            const quantidade  = Number(insumo.quantidade);
            if (!idDoInsumo || isNaN(quantidade) || quantidade <= 0) continue;
            const stockRef = db.collection("estoque").doc(idDoInsumo);
            const stockDoc = await stockRef.get();
            if (!stockDoc.exists) continue;
            if (stockDoc.data().userId !== after.userId) continue;
            batch.update(stockRef, { quantidade: admin.firestore.FieldValue.increment(-quantidade), ultimaAtualizacao: admin.firestore.FieldValue.serverTimestamp() });
        }
        batch.update(transacaoRef, { estoqueJaDecrementado: true, estoqueDecrementadoEm: admin.firestore.FieldValue.serverTimestamp() });
        await batch.commit();
    } catch (error) {
        console.error(`[${transactionId}] Erro crítico:`, error);
        throw error;
    }
});

// ─── 2. createStripeConnectAccount ────────────────────────────────────────────
exports.createStripeConnectAccount = onRequest(
    { cors: ["https://vetsmart-11674145-f2ba3.web.app", "https://vetsmart-11674145-f2ba3.firebaseapp.com"], secrets: ["STRIPE_SECRET_KEY"] },
    async (req, res) => {
        if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!idToken) return res.status(401).json({ error: "Token de autenticação obrigatório." });

        let decodedToken;
        try { decodedToken = await admin.auth().verifyIdToken(idToken); }
        catch { return res.status(401).json({ error: "Token inválido ou expirado." }); }

        const { vetKey, email } = req.body;
        if (!vetKey || !email) return res.status(400).json({ error: "vetKey e email são obrigatórios." });

        // Ownership check: apenas o próprio vet pode criar sua conta Stripe
        if (vetKey !== decodedToken.uid) {
            return res.status(403).json({ error: "Acesso não autorizado: vetKey incompatível com token." });
        }

        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        try {
            const vetRef  = db.collection("veterinarios").doc(vetKey);
            const vetSnap = await vetRef.get();
            if (!vetSnap.exists) return res.status(404).json({ error: "Veterinário não encontrado." });
            const vetData = vetSnap.data();
            let accountId = vetData.stripeAccountId;
            if (!accountId) {
                const account = await stripe.accounts.create({
                    type: "express", email,
                    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
                    business_type: vetData.tipo === "pj" ? "company" : "individual",
                    metadata: { vetKey }
                });
                accountId = account.id;
                await vetRef.update({ stripeAccountId: accountId });
            }
            const accountLink = await stripe.accountLinks.create({
                account: accountId,
                refresh_url: `https://vetsmart-11674145-f2ba3.web.app/dashboard.html`,
                return_url:  `https://vetsmart-11674145-f2ba3.web.app/dashboard.html?stripe_return=true`,
                type: "account_onboarding"
            });
            return res.status(200).json({ url: accountLink.url });
        } catch (error) {
            console.error("Erro no Stripe Connect:", error);
            return res.status(500).json({ error: "Erro interno do servidor." });
        }
    }
);

// ─── 3. createStripeBillingSubscription ──────────────────────────────────────
exports.createStripeBillingSubscription = onRequest(
    { cors: ["https://vetsmart-11674145-f2ba3.web.app", "https://vetsmart-11674145-f2ba3.firebaseapp.com"], secrets: ["STRIPE_SECRET_KEY"] },
    async (req, res) => {
        if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!idToken) return res.status(401).json({ error: "Token de autenticação obrigatório." });

        let decodedToken;
        try { decodedToken = await admin.auth().verifyIdToken(idToken); }
        catch { return res.status(401).json({ error: "Token inválido ou expirado." }); }

        const { userId, email, priceId } = req.body;
        if (!userId || !email || !priceId) return res.status(400).json({ error: "userId, email e priceId obrigatórios." });

        // Ownership check: apenas o próprio vet pode criar sua assinatura
        if (userId !== decodedToken.uid) {
            return res.status(403).json({ error: "Acesso não autorizado: userId incompatível com token." });
        }

        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        const PRICE_ID = process.env.STRIPE_PRICE_ID_BILLING || "price_1TSJR0Cmf9tQfhiKQyKqyBHM";

        try {
            const vetRef  = db.collection("veterinarios").doc(userId);
            const vetSnap = await vetRef.get();
            if (!vetSnap.exists) return res.status(404).json({ error: "Veterinário não encontrado." });
            const vetData = vetSnap.data();

            // Idempotência: não criar assinatura duplicada
            if (vetData.stripeSubscriptionId) {
                return res.status(200).json({ success: true, customerId: vetData.stripeCustomerId, subscriptionId: vetData.stripeSubscriptionId, message: "Assinatura já existente." });
            }

            let customerId = vetData.stripeCustomerId;
            if (!customerId) {
                const customer = await stripe.customers.create({ email, name: vetData.nome || vetData.razao_social, metadata: { userId, tipo: vetData.tipo } });
                customerId = customer.id;
            }

            const subscription = await stripe.subscriptions.create({
                customer: customerId, items: [{ price: PRICE_ID }],
                trial_period_days: 30, payment_behavior: "create_if_required",
                metadata: { userId }
            });

            await vetRef.update({
                stripeCustomerId: customerId, stripeSubscriptionId: subscription.id,
                subscriptionStatus: subscription.status, stripeStatus: subscription.status,
                subscriptionCreatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.status(200).json({ success: true, customerId, subscriptionId: subscription.id });
        } catch (error) {
            console.error("Erro no Billing:", error);
            return res.status(500).json({ error: "Erro interno do servidor." });
        }
    }
);

// ─── 4. stripeWebhook ─────────────────────────────────────────────────────────
exports.stripeWebhook = onRequest(
    { rawBody: true, secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
    async (req, res) => {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        const sig = req.headers["stripe-signature"];
        let event;
        try {
            event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // Idempotência — verificar ANTES de processar, marcar APÓS processamento bem-sucedido
        const eventRef = db.collection("stripe_events_cf").doc(event.id);
        try {
            const eventSnap = await eventRef.get();
            if (eventSnap.exists) return res.status(200).json({ received: true, duplicate: true });
        } catch (e) { console.error("Erro ao verificar idempotência:", e); }

        // Processar evento
        try {
            if (event.type === "checkout.session.completed") {
                const session = event.data.object;
                const transacaoId = session?.metadata?.transacaoId;
                if (transacaoId) {
                    await db.collection("atendimentos").doc(transacaoId).update({
                        status: "pago", pagamentoConfirmadoEm: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }

            if (event.type === "account.updated") {
                const account = event.data.object;
                const userId = account.metadata?.userId || account.metadata?.vetKey;
                if (userId) {
                    const isActive = account.charges_enabled && account.payouts_enabled;
                    await db.collection("veterinarios").doc(userId).update({
                        stripeStatus: isActive ? "active" : "pending",
                        stripeAccountId: account.id,
                        stripeUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }

            if (event.type === "customer.subscription.updated") {
                const subscription = event.data.object;
                const userId = subscription.metadata?.userId;
                if (userId) {
                    await db.collection("veterinarios").doc(userId).update({
                        stripeStatus: subscription.status,
                        subscriptionStatus: subscription.status,
                        stripeUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }

            if (event.type === "invoice.payment_succeeded") {
                const invoice = event.data.object;
                const customerId = invoice.customer;
                // Guard: só processar se houver linhas na fatura
                if (customerId && invoice.lines?.data?.length > 0) {
                    const querySnapshot = await db.collection("veterinarios").where("stripeCustomerId", "==", customerId).limit(1).get();
                    if (!querySnapshot.empty) {
                        await querySnapshot.docs[0].ref.update({
                            lastInvoicePaidAt: admin.firestore.FieldValue.serverTimestamp(),
                            nextBillingDate: new Date(invoice.lines.data[0].period.end * 1000)
                        });
                    }
                }
            }

            // Marcar como processado SOMENTE após sucesso
            await eventRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp(), type: event.type });
        } catch (processingError) {
            console.error(`Erro ao processar evento ${event.id} (${event.type}):`, processingError);
            // Não retornar 500 aqui — retornar 200 para eventos que não afetam dados críticos
            // Para pagamentos críticos, o erro já foi logado e pode ser monitorado
        }

        return res.json({ received: true });
    }
);

// ─── 5. createVeterinarianRecord ──────────────────────────────────────────────
exports.createVeterinarianRecord = onRequest(
    { cors: ["https://vetsmart-11674145-f2ba3.web.app", "https://vetsmart-11674145-f2ba3.firebaseapp.com"], secrets: ["STRIPE_SECRET_KEY"] },
    async (req, res) => {
        if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!idToken) return res.status(401).json({ error: "Token de autenticação ausente." });

        let decodedToken;
        try { decodedToken = await admin.auth().verifyIdToken(idToken); }
        catch (authErr) { return res.status(401).json({ error: "Token inválido ou expirado." }); }

        const { vetKey, vetData } = req.body;
        if (!vetKey || vetKey !== decodedToken.uid) return res.status(403).json({ error: "Acesso não autorizado." });
        if (!vetData || typeof vetData !== 'object') return res.status(400).json({ error: "Dados do veterinário inválidos." });

        // Whitelist de campos — previne mass assignment
        const safeData = Object.fromEntries(
            Object.entries(vetData).filter(([k]) => VET_ALLOWED_FIELDS.includes(k))
        );
        safeData.createdAt = admin.firestore.FieldValue.serverTimestamp();
        safeData.uid = vetKey;
        safeData.ativo = false;
        safeData.stripeStatus = 'pending';

        try {
            await db.collection("veterinarios").doc(vetKey).set(safeData);
            return res.status(200).json({ success: true, vetKey });
        } catch (error) {
            console.error("Erro ao criar registro:", error);
            return res.status(500).json({ error: "Erro interno do servidor." });
        }
    }
);
